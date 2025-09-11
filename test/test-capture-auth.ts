import { PaypalService } from "./src/providers/paypal/paypal-core/paypal-core";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function testCaptureAuthorizationDirectly() {
  console.log("========================================");
  console.log("PayPal Direct Authorization Capture Test");
  console.log("========================================\n");

  // Initialize PayPal service with credentials from .env
  const paypalService = new PaypalService({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
    includeCustomerData: true,
    includeShippingData: true,
  });

  // The authorization ID from your screenshot (Transaction ID)
  const authorizationId = "8UF769457P534454V";
  
  try {
    console.log("Attempting to capture authorization directly...");
    console.log(`Authorization ID: ${authorizationId}`);
    console.log(`Amount shown in screenshot: $115.92 USD\n`);
    
    console.log("========================================");
    console.log("Calling captureAuthorization method...");
    console.log("========================================\n");
    
    try {
      // Directly capture the authorization
      const captureResult = await paypalService.captureAuthorization(authorizationId);
      
      console.log("✅ SUCCESS: Authorization captured!");
      console.log("\nCapture Response:");
      console.log(JSON.stringify(captureResult, null, 2));
      
      if (captureResult.status === "COMPLETED") {
        console.log("\n✅ Payment successfully captured and completed!");
        console.log(`Capture ID: ${captureResult.id}`);
        console.log(`Amount: ${captureResult.amount?.value} ${captureResult.amount?.currencyCode}`);
      }
      
    } catch (captureError: any) {
      console.error("\n❌ CAPTURE FAILED:");
      console.error(`Error Message: ${captureError.message}`);
      
      // Check if it's an API error response
      if (captureError.response) {
        console.error("\nAPI Response Error:");
        console.error(JSON.stringify(captureError.response.data, null, 2));
      } else if (captureError.statusCode) {
        console.error(`Status Code: ${captureError.statusCode}`);
        if (captureError.body) {
          console.error("Error Body:", JSON.stringify(captureError.body, null, 2));
        }
      }
      
      // Common error scenarios
      if (captureError.message?.includes("AUTHORIZATION_ALREADY_CAPTURED")) {
        console.log("\n⚠️  This authorization has already been captured.");
      } else if (captureError.message?.includes("AUTHORIZATION_EXPIRED")) {
        console.log("\n⚠️  This authorization has expired (authorizations expire after 29 days).");
      } else if (captureError.message?.includes("AUTHORIZATION_VOIDED")) {
        console.log("\n⚠️  This authorization has been voided.");
      } else if (captureError.message?.includes("INVALID_RESOURCE_ID")) {
        console.log("\n⚠️  Invalid authorization ID. This might be an Order ID instead of an Authorization ID.");
      }
    }
    
    console.log("\n========================================");
    console.log("Test Complete");
    console.log("========================================");
    
  } catch (error: any) {
    console.error("\n❌ Unexpected ERROR during test:");
    console.error(error.message);
    console.error("\nStack trace:");
    console.error(error.stack);
  }
}

// Alternative: Try to search for the order by session ID
async function findOrderBySessionId() {
  console.log("\n========================================");
  console.log("Alternative: Searching by Session ID");
  console.log("========================================\n");
  
  const sessionId = "payses_01K4SRP7MQG4WVX49FNV8EJW3F";
  console.log(`Session ID from screenshot: ${sessionId}`);
  console.log("\nNote: PayPal API doesn't provide a direct way to search orders by custom_id.");
  console.log("You would need to:");
  console.log("1. Check your Medusa database for the payment session");
  console.log("2. Find the associated PayPal Order ID");
  console.log("3. Use that Order ID to retrieve and capture the payment");
}

// Run the test
console.log("Starting PayPal authorization capture test...\n");

testCaptureAuthorizationDirectly()
  .then(() => findOrderBySessionId())
  .then(() => {
    console.log("\nTest execution completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nUnexpected error:", error);
    process.exit(1);
  });