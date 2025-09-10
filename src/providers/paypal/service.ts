import { AbstractPaymentProvider, MedusaError, PaymentSessionStatus, PaymentActions } from "@medusajs/framework/utils";
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  RefundPaymentInput,
  RefundPaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
  ProviderWebhookPayload,
} from "@medusajs/framework/types";
import { CaptureStatus, Order } from "@paypal/paypal-server-sdk";
import { WebhookPayload } from "./types";
import { PaypalCreateOrderInput, PaypalService } from "./paypal-core";
import { z } from "zod";

export interface PaypalPaymentError {
  code: string;
  message: string;
  retryable: boolean;
  avsCode?: string;
  cvvCode?: string;
}

const optionsSchema = z.object({
  clientId: z.string().min(1, "PayPal client ID is required"),
  clientSecret: z.string().min(1, "PayPal client secret is required"),
  isSandbox: z.boolean().default(false),
  webhookId: z.string().optional(),
  includeShippingData: z.boolean().default(false),
  includeCustomerData: z.boolean().default(false),
});

export type AlphabitePaypalPluginOptions = z.infer<typeof optionsSchema>;

type InjectedDependencies = {
  logger: Logger;
  paymentModuleService: any;
};

interface InitiatePaymentInputCustom extends Omit<InitiatePaymentInput, "data"> {
  data?: Pick<PaypalCreateOrderInput, "items" | "shipping_info" | "email">;
}

interface AuthorizePaymentInputData extends Pick<PaypalCreateOrderInput, "items" | "shipping_info" | "email"> {}

export default class PaypalModuleService extends AbstractPaymentProvider<AlphabitePaypalPluginOptions> {
  static identifier = "paypal";

  protected client: PaypalService;
  protected logger: Logger;
  protected paymentModuleService: any;

  constructor(container: InjectedDependencies, private readonly options: AlphabitePaypalPluginOptions) {
    super(container, options);

    this.logger = container.logger;
    this.paymentModuleService = container.paymentModuleService;

    this.client = new PaypalService(this.options);
  }

  static validateOptions(options: AlphabitePaypalPluginOptions): void {
    const result = optionsSchema.safeParse(options);

    if (!result.success) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid PayPal plugin options: ${result.error.message}`);
    }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment data is required");
      }

      const orderId = input.data.id as string;
      if (!orderId) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayPal order ID is required to capture payment");
      }
      
      // Validate order ID format
      if (!this.validatePayPalOrderId(orderId)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid PayPal order ID format");
      }

      // First check the actual status from PayPal
      const orderDetails = await this.client.retrieveOrder(orderId);
      
      this.logger.info(`PayPal order ${orderId} current status: ${orderDetails.status}`);
      
      // Check if already captured on PayPal's side
      if (orderDetails.status === "COMPLETED") {
        this.logger.info(`PayPal order ${orderId} is already completed/captured`);
        return {
          data: {
            ...input.data,
            ...orderDetails,
            status: PaymentSessionStatus.CAPTURED,
            captured_at: orderDetails.purchaseUnits?.[0]?.payments?.captures?.[0]?.createTime || new Date().toISOString(),
          },
        };
      }

      // Check if order has authorization that needs to be captured
      const authorization = orderDetails.purchaseUnits?.[0]?.payments?.authorizations?.[0];
      
      if (authorization && authorization.status === "CREATED") {
        this.logger.info(`Capturing PayPal authorization ${authorization.id} for order ${orderId}`);
        
        // Use the captureOrder method which now properly handles authorizations
        const capturedOrder = await this.client.captureOrder(orderId);
        
        return {
          data: {
            ...input.data,
            ...capturedOrder,
            status: PaymentSessionStatus.CAPTURED,
            captured_at: capturedOrder.purchaseUnits?.[0]?.payments?.captures?.[0]?.createTime || new Date().toISOString(),
          },
        };
      }

      // If status is APPROVED (but no authorization), try to capture directly
      if (orderDetails.status === "APPROVED") {
        this.logger.info(`Capturing PayPal order ${orderId} directly`);
        const capturedOrder = await this.client.captureOrder(orderId);
        
        return {
          data: {
            ...input.data,
            ...capturedOrder,
            status: PaymentSessionStatus.CAPTURED,
            captured_at: capturedOrder.purchaseUnits?.[0]?.payments?.captures?.[0]?.createTime || new Date().toISOString(),
          },
        };
      }

      // If status is neither COMPLETED nor has authorization, throw error
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA, 
        `PayPal order ${orderId} is in status ${orderDetails.status} with no valid authorization, cannot capture`
      );

    } catch (error) {
      this.logger.error("PayPal capture payment error:", error);
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Failed to capture PayPal payment: ${error.message}`);
    }
  }
  
  private async captureAuthorization(authorizationId: string): Promise<any> {
    try {
      // Validate authorization ID format (PayPal IDs are alphanumeric with specific length)
      if (!authorizationId || typeof authorizationId !== 'string') {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Invalid authorization ID"
        );
      }
      
      // PayPal authorization IDs are typically 17-20 alphanumeric characters
      const authIdPattern = /^[A-Z0-9]{17,20}$/;
      if (!authIdPattern.test(authorizationId)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Invalid PayPal authorization ID format"
        );
      }
      
      const accessToken = await this.client.getAccessToken();
      const baseUrl = this.options.isSandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
      
      // Use encodeURIComponent to prevent injection
      const sanitizedAuthId = encodeURIComponent(authorizationId);
      const response = await fetch(`${baseUrl}/v2/payments/authorizations/${sanitizedAuthId}/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}), // Empty body for capture
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to capture authorization: ${error.message || response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      this.logger.error("Failed to capture PayPal authorization:", error);
      throw error;
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    if (!input.data) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment data is required");
    }

    const data = input.data as unknown as AuthorizePaymentInputData | undefined;
    let paypalData = input.data as Order | undefined;

    const amount = input.data.amount as number;
    const currencyCode = input.data.currency_code as string;
    const orderId = paypalData?.id as string;

    if (!orderId || !amount || !currencyCode) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal order ID, Amount or Currency is missing, can not authorize order."
      );
    }

    // Get the latest order status from PayPal
    try {
      paypalData = await this.client.retrieveOrder(orderId);
    } catch (error) {
      this.logger.error("Failed to retrieve PayPal order:", error);
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Failed to retrieve PayPal order status"
      );
    }

    const orderStatus = paypalData?.status;
    const authorizationData = paypalData?.purchaseUnits?.[0].payments?.authorizations?.[0];
    const captureData = paypalData?.purchaseUnits?.[0].payments?.captures?.[0];

    // PayPal order flow:
    // 1. CREATED -> order created but not approved by user
    // 2. APPROVED -> user approved payment in PayPal
    // 3. COMPLETED -> payment has been captured (we should avoid this in authorize)
    
    // If order is approved by user, authorize it
    if (orderStatus === "APPROVED") {
      try {
        // Authorize the payment (this should create an authorization, not capture)
        const authorizedOrder = await this.client.authorizeOrder(orderId);
        
        // Check if authorization was successful
        const newAuthData = authorizedOrder?.purchaseUnits?.[0].payments?.authorizations?.[0];
        
        // Authorization should have status "CREATED" for a successful authorization
        // "CAPTURED" would mean it was auto-captured, which we want to avoid
        if (newAuthData && newAuthData.status === "CREATED") {
          return {
            data: authorizedOrder as unknown as Record<string, unknown>,
            status: PaymentSessionStatus.AUTHORIZED,  // Return AUTHORIZED, not CAPTURED
          };
        }
        
        // If somehow it was captured instead of authorized, still return as authorized
        // to prevent immediate fund transfer - this needs manual review
        if (newAuthData && newAuthData.status === "CAPTURED") {
          this.logger.warn("PayPal order was auto-captured instead of authorized. Check PayPal account settings.");
          return {
            data: authorizedOrder as unknown as Record<string, unknown>,
            status: PaymentSessionStatus.AUTHORIZED,  // Still return AUTHORIZED to prevent issues
          };
        }
        
        // Check if there's capture data (shouldn't happen with authorize intent)
        const captureData = authorizedOrder?.purchaseUnits?.[0].payments?.captures?.[0];
        if (captureData) {
          this.logger.warn("PayPal returned capture data in authorize call. Check PayPal account settings.");
          return {
            data: authorizedOrder as unknown as Record<string, unknown>,
            status: PaymentSessionStatus.AUTHORIZED,  // Still return AUTHORIZED
          };
        }
        
        // If authorization failed, return error
        return {
          data: authorizedOrder as unknown as Record<string, unknown>,
          status: PaymentSessionStatus.ERROR,
        };
      } catch (error) {
        this.logger.error("Failed to authorize PayPal payment:", error);
        
        // Parse error to get more details
        const errorBody = error?.body ? JSON.parse(error.body) : {};
        const errorMessage = errorBody?.message || "Failed to authorize payment";
        
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayPal authorization failed: ${errorMessage}`
        );
      }
    }

    // If we already have authorization data, return as authorized
    if (authorizationData && authorizationData.status === "CREATED") {
      return {
        data: paypalData as unknown as Record<string, unknown>,
        status: PaymentSessionStatus.AUTHORIZED,
      };
    }
    
    // Only return CAPTURED if this is being called on an already captured payment
    // This shouldn't happen in normal flow, but handle it gracefully
    if (orderStatus === "COMPLETED" || captureData?.status === "COMPLETED") {
      this.logger.warn("Authorize called on already captured PayPal order");
      return {
        data: paypalData as unknown as Record<string, unknown>,
        status: PaymentSessionStatus.CAPTURED,
      };
    }
    
    // If order is not approved yet, return as pending
    if (orderStatus === "CREATED") {
      return {
        data: paypalData as unknown as Record<string, unknown>,
        status: PaymentSessionStatus.PENDING,
      };
    }

    // For any other status, return as error
    return {
      data: paypalData as unknown as Record<string, unknown>,
      status: PaymentSessionStatus.ERROR,
    };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment data is required");
      }

      const orderId = input.data["id"] as string;

      if (!orderId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Cancel payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error("PayPal cancel payment error:", error);

      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Failed to cancel PayPal payment");
    }
  }

  async initiatePayment(input: InitiatePaymentInputCustom): Promise<InitiatePaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment data is required");
      }

      const { amount, currency_code, context, data } = input;

      if (!amount || !currency_code) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Amount and currency code are required");
      }

      const order = await this.client.createOrder({
        amount: Number(amount),
        currency: currency_code,
        sessionId: context?.idempotency_key,
        items: data?.items,
        shipping_info: data?.shipping_info,
        email: data?.email,
      });

      return {
        data: { ...data, ...order, ...context, amount, currency_code },

        id: order.id!,
      };
    } catch (error) {
      this.logger.error("PayPal initiate payment error:", error);
      throw error;
    }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment data is required");
      }

      const orderId = input.data["id"] as string;
      const purchaseUnits = (input?.data?.["purchaseUnits"] as Order["purchaseUnits"]) || [];

      const captureIds = purchaseUnits
        ?.flatMap((item) => item?.payments?.captures?.map((capture) => capture.id))
        .filter((id) => id !== undefined);

      if (!orderId || !captureIds || captureIds.length === 0) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Refund payment failed! PayPal order ID and capture ID is required to refund payment"
        );
      }
      
      // Validate order ID
      if (!this.validatePayPalOrderId(orderId)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid PayPal order ID format");
      }
      
      // Validate all capture IDs
      for (const captureId of captureIds) {
        if (!this.validatePayPalCaptureId(captureId)) {
          throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid PayPal capture ID format");
        }
      }

      await this.client.refundPayment(captureIds);

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error("PayPal refund payment error:", error);

      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Failed to refund PayPal payment");
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment data is required");
      }

      const orderId = input.data["id"] as string;

      if (!orderId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Delete payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error("PayPal cancel payment error:", error);
      throw error;
    }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment data is required");
      }

      const order_id = input.data["id"] as string;

      if (!order_id) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayPal order ID is required to get payment status");
      }
      
      // Validate order ID format
      if (!this.validatePayPalOrderId(order_id)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid PayPal order ID format");
      }

      const order = await this.client.retrieveOrder(order_id);

      if (!order || !order.status) {
        throw new MedusaError(MedusaError.Types.NOT_FOUND, `PayPal order with ID ${order_id} not found`);
      }

      return {
        status: order.status === "COMPLETED" ? PaymentSessionStatus.CAPTURED : PaymentSessionStatus.AUTHORIZED,
      };
    } catch (error) {
      this.logger.error("PayPal get payment status error:", error);
      throw error;
    }
  }

  async retrievePayment(input: Record<string, unknown>) {
    try {
      const id = input["id"] as string;
      
      if (!id || !this.validatePayPalOrderId(id)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid PayPal order ID");
      }

      const res = await this.client.retrieveOrder(id);
      return {
        data: { response: res },
      };
    } catch (error) {
      this.logger.error("PayPal retrieve payment error:", error);
      throw error;
    }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Not implemented");
  }

  /**
   * Constructs and validates a PayPal webhook event
   * Similar to Stripe's constructWebhookEvent method
   */
  constructWebhookEvent(data: ProviderWebhookPayload["payload"]): any {
    // Extract PayPal-specific headers
    const headers = data.headers as Record<string, string>;
    const requiredHeaders = [
      "paypal-auth-algo",
      "paypal-cert-url", 
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time"
    ];

    // Validate required headers are present
    for (const header of requiredHeaders) {
      if (!headers[header]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Missing required PayPal webhook header: ${header}`
        );
      }
    }

    // Parse the webhook body
    let webhookEvent: any;
    try {
      webhookEvent = typeof data.rawData === "string" 
        ? JSON.parse(data.rawData)
        : data.rawData;
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Invalid webhook payload format"
      );
    }

    // Return the validated webhook data with headers for verification
    return {
      headers,
      body: webhookEvent
    };
  }

  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    try {
      // Construct and validate the webhook event
      const event = this.constructWebhookEvent(payload);
      
      // Verify webhook signature with PayPal
      await this.client.verifyWebhook({ 
        headers: event.headers, 
        body: event.body 
      });

      // Extract event details
      const eventType = event.body.event_type;
      const resource = event.body.resource;
      
      // Get session ID and amount from resource
      const sessionId = resource?.custom_id || resource?.invoice_id;
      const amount = resource?.amount?.value ? Number(resource.amount.value) : 0;

      // Map PayPal events to Medusa PaymentActions
      switch (eventType) {
        case "PAYMENT.CAPTURE.COMPLETED":
          return {
            action: PaymentActions.SUCCESSFUL,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        case "PAYMENT.CAPTURE.PENDING":
          return {
            action: PaymentActions.PENDING,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        case "PAYMENT.CAPTURE.DENIED":
        case "PAYMENT.CAPTURE.FAILED":
          return {
            action: PaymentActions.FAILED,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        case "PAYMENT.AUTHORIZATION.CREATED":
          return {
            action: PaymentActions.AUTHORIZED,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        case "PAYMENT.AUTHORIZATION.VOIDED":
          return {
            action: PaymentActions.CANCELED,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        case "CHECKOUT.ORDER.APPROVED":
          // Order approved by user but needs capture
          return {
            action: PaymentActions.REQUIRES_MORE,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        case "CHECKOUT.PAYMENT-APPROVAL.REVERSED":
          // Payment was reversed after approval
          return {
            action: PaymentActions.FAILED,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        case "PAYMENT.CAPTURE.REFUNDED":
        case "PAYMENT.REFUND.COMPLETED":
          // Handle refund events - Note: PaymentActions doesn't have REFUNDED, 
          // so we use SUCCESSFUL for completed refunds
          return {
            action: PaymentActions.SUCCESSFUL,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
          
        default:
          this.logger.warn(`Unsupported PayPal webhook event type: ${eventType}`);
          return {
            action: PaymentActions.NOT_SUPPORTED,
          };
      }
    } catch (error) {
      this.logger.error("PayPal webhook processing error:", error);
      
      // If we can't verify the webhook, return failed
      // Note: We can't include error details in data, so just log them
      return {
        action: PaymentActions.FAILED,
      };
    }
  }

  private checkPaymentStatus(
    status: CaptureStatus,
    processorResponse?: {
      avsCode?: string;
      cvvCode?: string;
      responseCode?: string;
    }
  ): { status: CaptureStatus; error?: PaypalPaymentError } {
    const processorResponseMap: Record<string, PaypalPaymentError> = {
      "0500": {
        code: "0500 - DO_NOT_HONOR",
        message: "Card refused by issuer. Please try again or use a different card.",
        retryable: false,
      },
      "9500": {
        code: "9500 - SUSPECTED_FRAUD",
        message: "Suspected fraudulent card. Please try again and use a different card.",
        retryable: false,
      },
      "5400": {
        code: "5400 - EXPIRED_CARD",
        message: "Card has expired. Please try again and use a different card.",
        retryable: false,
      },
      "5120": {
        code: "5120 - INSUFFICIENT_FUNDS",
        message: "Insufficient funds. Please try again or use a different card.",
        retryable: true,
      },
      "00N7": {
        code: "00N7 - CVV_FAILURE",
        message: "Incorrect security code. Please try again or use a different card.",
        retryable: true,
      },
      "1330": {
        code: "1330 - INVALID_ACCOUNT",
        message: "Card not valid. Please try again or use a different card.",
        retryable: true,
      },
      "5100": {
        code: "5100 - GENERIC_DECLINE",
        message: "Card is declined. Please try again or use a different card.",
        retryable: true,
      },
    };

    switch (status) {
      case "COMPLETED":
        return { status };

      case "DECLINED":
        if (processorResponse?.responseCode) {
          const errorDetails = processorResponseMap[processorResponse.responseCode] || {
            code: processorResponse.responseCode,
            message: "Payment declined. Please try again or use a different card.",
            retryable: false,
          };

          return {
            status,
            error: {
              ...errorDetails,
              avsCode: processorResponse.avsCode,
              cvvCode: processorResponse.cvvCode,
            },
          };
        }

        return {
          status,
          error: {
            code: "DECLINED",
            message: "Payment declined. Please try again or use a different card.",
            retryable: false,
          },
        };

      default:
        return {
          status,
          error: {
            code: "UNKNOWN_STATUS",
            message: `Unknown payment status: ${status}. Please try again or use a different card.`,
            retryable: false,
          },
        };
    }
  }
  
  /**
   * Validates PayPal order ID format
   * PayPal order IDs are typically 17 alphanumeric characters
   */
  private validatePayPalOrderId(orderId: string): boolean {
    if (!orderId || typeof orderId !== 'string') {
      return false;
    }
    // PayPal order IDs are typically 17 alphanumeric characters
    const orderIdPattern = /^[A-Z0-9]{17}$/;
    return orderIdPattern.test(orderId);
  }
  
  /**
   * Validates PayPal capture ID format
   * PayPal capture IDs are typically 17-20 alphanumeric characters
   */
  private validatePayPalCaptureId(captureId: string): boolean {
    if (!captureId || typeof captureId !== 'string') {
      return false;
    }
    const captureIdPattern = /^[A-Z0-9]{17,20}$/;
    return captureIdPattern.test(captureId);
  }
}
