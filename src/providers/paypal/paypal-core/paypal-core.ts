import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  LogLevel,
  OAuthAuthorizationController,
  Order,
  OrderAuthorizeResponse,
  OrdersController,
  PaymentsController,
  Refund,
  Item,
  ShippingDetails,
  OrderApplicationContextShippingPreference,
  OrderApplicationContextUserAction,
  FulfillmentType,
} from "@paypal/paypal-server-sdk";
import { CartAddressDTO, CartLineItemDTO } from "@medusajs/framework/types";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { AlphabitePaypalPluginOptions } from "../service";
import { MedusaError } from "@medusajs/framework/utils";

export interface PaypalCreateOrderInput {
  amount: number;
  currency: string;
  sessionId?: string;
  shipping_info?: CartAddressDTO;
  items?: CartLineItemDTO[];
  email?: string;
}

export class PaypalService {
  private client: Client;
  private ordersController: OrdersController;
  private paymentsController: PaymentsController;
  private authController: OAuthAuthorizationController;
  private clientId: string;
  private clientSecret: string;
  private webhookId: string | undefined;
  private includeShippingData: boolean;
  private includeCustomerData: boolean;
  private baseUrl: string;

  constructor({
    clientId,
    clientSecret,
    isSandbox,
    webhookId,
    includeCustomerData,
    includeShippingData,
  }: AlphabitePaypalPluginOptions) {
    const environment = isSandbox ? Environment.Sandbox : Environment.Production;

    this.client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
      timeout: 0,
      environment,
      logging: {
        logLevel: LogLevel.Info,
        logRequest: {
          logBody: true,
        },
        logResponse: {
          logHeaders: true,
        },
      },
    });

    this.baseUrl = isSandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.webhookId = webhookId;

    this.ordersController = new OrdersController(this.client);
    this.paymentsController = new PaymentsController(this.client);
    this.authController = new OAuthAuthorizationController(this.client);

    this.includeCustomerData = !!includeCustomerData;
    this.includeShippingData = !!includeShippingData;
  }

  async getAccessToken(): Promise<string> {
    try {
      const authorization = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

      const authRes = await this.authController.requestToken({
        authorization: `Basic ${authorization}`,
      });

      const accessToken = authRes.result.accessToken;

      if (!accessToken) throw new Error("Failed to get access token");

      return accessToken;
    } catch (error) {
      throw new Error("Failed to get access token: " + error.message);
    }
  }

  async createOrder({
    amount,
    currency,
    sessionId,
    shipping_info,
    items,
    email,
  }: PaypalCreateOrderInput): Promise<Order> {
    const ordersController = new OrdersController(this.client);

    // Format amount to 2 decimal places as required by PayPal
    const formattedAmount = this.formatAmount(amount);

    const paypalItems: Item[] =
      items?.map((item) => ({
        name: item.title,
        quantity: item.quantity.toString(),
        unitAmount: {
          currencyCode: currency,
          value: this.formatAmount(Number(item.unit_price)),
        },
      })) || [];

    const hasItems = paypalItems.length > 0;

    // Calculate item total if items are present
    const itemTotal = hasItems && items
      ? items.reduce((sum, item) => sum + (Number(item.unit_price) * Number(item.quantity)), 0)
      : amount;
    const formattedItemTotal = this.formatAmount(itemTotal);

    const shippingData: ShippingDetails | false = !!shipping_info && {
      ...(this.includeCustomerData && this.mapCustomerData({ email, shipping_info })),
      ...(this.includeShippingData && this.mapShippingData(shipping_info)),
      type: FulfillmentType.Shipping,
    };

    const createdOrder = await ordersController.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [
          {
            amount: {
              currencyCode: currency,
              value: formattedAmount,
              ...(hasItems && {
                breakdown: {
                  itemTotal: {
                    currencyCode: currency,
                    value: formattedItemTotal,
                  },
                },
              }),
            },
            customId: sessionId,
            ...(hasItems && { items: paypalItems }),
            ...(shippingData && { shipping: shippingData }),
          },
        ],
        applicationContext: {
          ...(this.includeShippingData &&
            shippingData && {
              shippingPreference: OrderApplicationContextShippingPreference.SetProvidedAddress,
            }),
          userAction: OrderApplicationContextUserAction.PayNow,
        },
      },
    });

    if (!createdOrder?.result?.id) throw new Error("Failed to create order");

    return createdOrder.result;
  }

  async captureOrder(id: string): Promise<Order> {
    // For AUTHORIZE intent, we need to capture the authorization, not the order
    const orderDetails = await this.retrieveOrder(id);
    
    // Log current order status for debugging
    console.log(`[PayPal] Order ${id} status: ${orderDetails.status}`);
    
    // Check if order has authorization that can be captured
    const authorization = orderDetails.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    
    if (authorization && authorization.id && authorization.status === "CREATED") {
      console.log(`[PayPal] Capturing authorization ${authorization.id} for order ${id}`);
      // Capture the authorization using the correct SDK method
      const capturedPayment = await this.captureAuthorization(authorization.id);
      
      // Get updated order details after capture
      const updatedOrder = await this.retrieveOrder(id);
      return updatedOrder;
    }
    
    // Check if already captured
    const capture = orderDetails.purchaseUnits?.[0]?.payments?.captures?.[0];
    if (capture && capture.status === "COMPLETED") {
      console.log(`[PayPal] Order ${id} already has completed capture`);
      return orderDetails;
    }
    
    // For CAPTURE intent orders (not AUTHORIZE), use direct capture
    if (orderDetails.intent === "CAPTURE" && orderDetails.status === "APPROVED") {
      console.log(`[PayPal] Direct capture for CAPTURE intent order ${id}`);
      const capturedOrder = await this.ordersController.captureOrder({
        id,
      });
      return capturedOrder.result;
    }
    
    throw new Error(`Cannot capture order ${id} in status ${orderDetails.status} with intent ${orderDetails.intent}`);
  }

  async captureAuthorization(authorizationId: string): Promise<any> {
    // Use the correct PayPal SDK method for capturing authorizations
    const capturedPayment = await this.paymentsController.captureAuthorizedPayment({
      authorizationId,
    });

    return capturedPayment.result;
  }

  async retrieveOrder(id: string): Promise<Order> {
    const orderDetails = await this.ordersController.getOrder({
      id,
    });

    return orderDetails.result;
  }

  async authorizeOrder(id: string): Promise<OrderAuthorizeResponse> {
    const authorizedOrder = await this.ordersController.authorizeOrder({
      id,
    });

    return authorizedOrder.result;
  }

  async refundPayment(captureIds: string[]): Promise<Refund[]> {
    const refunds: Refund[] = [];

    for (const captureId of captureIds) {
      const refund = await this.paymentsController.refundCapturedPayment({
        captureId,
      });

      refunds.push(refund.result);
    }

    return refunds;
  }

  public verifyWebhook = async ({
    headers,
    body,
  }: {
    headers: Record<string, string>;
    body: object;
  }): Promise<{ body: object; status: "SUCCESS" | "FAILURE" }> => {
    if (!this.webhookId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Webhook ID is not set");
    }

    const accessToken = await this.getAccessToken();

    const verifyWebhookRes = await fetch(`${this.baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: this.webhookId,
        webhook_event: body,
      }),
    });

    if (!verifyWebhookRes.ok) {
      throw new Error(`Failed to verify webhook signature: ${verifyWebhookRes.statusText}`);
    }

    const verifyWebhookData = await verifyWebhookRes.json();

    if (verifyWebhookData.verification_status !== "SUCCESS") {
      throw new Error("Failed to verify webhook signature");
    }

    return { status: verifyWebhookData.verification_status, body };
  };

  private mapCustomerData({
    email,
    shipping_info,
  }: {
    email?: string;
    shipping_info: PaypalCreateOrderInput["shipping_info"];
  }): Pick<ShippingDetails, "name" | "emailAddress" | "phoneNumber"> | undefined {
    if (!this.includeCustomerData || !shipping_info) {
      return undefined;
    }

    const parsedPhoneNumber = !!shipping_info?.phone && parsePhoneNumberFromString(shipping_info.phone);

    return {
      name: {
        fullName: `${shipping_info.first_name} ${shipping_info.last_name}`,
      },
      ...(email && { emailAddress: email }),
      ...(parsedPhoneNumber && {
        phoneNumber: {
          countryCode: parsedPhoneNumber.countryCallingCode,
          nationalNumber: parsedPhoneNumber.nationalNumber,
        },
      }),
    };
  }

  private mapShippingData(
    shipping_info: PaypalCreateOrderInput["shipping_info"]
  ): Pick<ShippingDetails, "address"> | undefined {
    if (!this.includeShippingData || !shipping_info || !shipping_info.country_code) {
      return undefined;
    }

    return {
      address: {
        countryCode: shipping_info.country_code,
        postalCode: shipping_info.postal_code,
        adminArea1: shipping_info.province,
        adminArea2: shipping_info.city,
        addressLine1: shipping_info.address_1,
      },
    };
  }

  /**
   * Formats an amount to 2 decimal places as required by PayPal
   * @param amount - The amount to format
   * @returns The formatted amount as a string with 2 decimal places
   */
  private formatAmount(amount: number): string {
    // Round to 2 decimal places to avoid floating point precision issues
    const rounded = Math.round(amount * 100) / 100;
    // Format to exactly 2 decimal places
    return rounded.toFixed(2);
  }
}
