import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { PostStorePaypalPaymentType } from "./validators";
import { PaypalService } from "../../../../providers/paypal/paypal-core";
import { AlphabitePaypalPluginOptions } from "../../../../providers/paypal/service";
import { MedusaError } from "@medusajs/framework/utils";
import { RateLimiter } from "../../../../utils/security";

interface PaymentProvidersProps {
  resolve: string;
  id: string;
  options: AlphabitePaypalPluginOptions;
}

// Initialize rate limiter (10 requests per minute)
const rateLimiter = new RateLimiter(10, 60000);

export const POST = async (req: MedusaRequest<PostStorePaypalPaymentType>, res: MedusaResponse) => {
  try {
    // Session validation
    const sessionId = req.body?.session_id;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 10) {
      return res.status(400).json({ error: "Invalid session ID" });
    }

    // Rate limiting by session ID
    const clientKey = `session_${sessionId}`;
    
    if (rateLimiter.isRateLimited(clientKey)) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    // Clean up old entries periodically (1% chance)
    if (Math.random() < 0.01) {
      rateLimiter.cleanup();
    }

    const paymentModule = req.scope.resolve("payment");

    // Type-safe provider access
    const moduleDeclaration = (paymentModule as any).moduleDeclaration;
    if (!moduleDeclaration?.providers) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment providers not configured");
    }
    
    const paymentProviders = moduleDeclaration.providers as PaymentProvidersProps[];

    const paypalProvider = paymentProviders.find((provider) => provider.id === "paypal");

    if (!paypalProvider) {
      return res.status(404).json({ error: "PayPal provider not found" });
    }

    // Use provider's configured sandbox setting instead of env variable
    const paypalService = new PaypalService(paypalProvider.options);
    const baseUrl = paypalProvider.options.isSandbox 
      ? "https://api-m.sandbox.paypal.com" 
      : "https://api-m.paypal.com";

    const accessToken = await paypalService.getAccessToken();

    const response = await fetch(`${baseUrl}/v1/identity/generate-token`, {
      method: "post",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": "en_US",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Failed to generate PayPal client token"
      );
    }

    const data = await response.json();

    if (!data.client_token) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Invalid response from PayPal"
      );
    }

    return res.status(201).json({ client_token: data.client_token });
  } catch (error) {
    // Don't expose internal error details
    console.error("PayPal client token generation error:", error);
    return res.status(500).json({ 
      error: "Failed to generate client token. Please try again later." 
    });
  }
};
