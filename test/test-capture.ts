import { PaypalService } from "./src/providers/paypal/paypal-core/paypal-core";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function testCaptureAuthorization() {
  console.log("========================================");
  console.log("PayPal Authorization Capture Test");
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
  
  // We need to find the order ID. In PayPal, the authorization ID and order ID are different.
  // The screenshot shows this is an authorization transaction, not an order ID.
  
  try {
    console.log("Step 1: Retrieving order details...");
    console.log(`Order ID: ${orderId}\n`);
    
    // First, get the current order details
    const orderDetails = await paypalService.retrieveOrder(orderId);
    
    console.log("Order Details:");
    console.log(`- Status: ${orderDetails.status}`);
    console.log(`- Intent: ${orderDetails.intent}`);
    console.log(`- Create Time: ${orderDetails.createTime}`);
    
    // Check for authorization
    const authorization = orderDetails.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    
    if (authorization) {
      console.log("\nAuthorization Found:");
      console.log(`- Authorization ID: ${authorization.id}`);
      console.log(`- Status: ${authorization.status}`);
      console.log(`- Amount: ${authorization.amount?.value} ${authorization.amount?.currencyCode}`);
      console.log(`- Expiration: ${authorization.expirationTime}`);
      
      if (authorization.status === "CREATED" || authorization.status === "PENDING") {
        console.log("\n========================================");
        console.log("Step 2: Attempting to capture authorization...");
        console.log("========================================\n");
        
        try {
          // Attempt to capture the order (which will internally capture the authorization)
          const capturedOrder = await paypalService.captureOrder(orderId);
          
          console.log("✅ SUCCESS: Authorization captured!");
          console.log("\nCaptured Order Details:");
          console.log(`- Order Status: ${capturedOrder.status}`);
          
          // Check for capture details
          const capture = capturedOrder.purchaseUnits?.[0]?.payments?.captures?.[0];
          if (capture) {
            console.log("\nCapture Details:");
            console.log(`- Capture ID: ${capture.id}`);
            console.log(`- Status: ${capture.status}`);
            console.log(`- Amount: ${capture.amount?.value} ${capture.amount?.currencyCode}`);
            console.log(`- Final Capture: ${capture.finalCapture}`);
            console.log(`- Create Time: ${capture.createTime}`);
            
            if (capture.status === "COMPLETED") {
              console.log("\n✅ Payment successfully captured and completed!");
            }
          }
          
        } catch (captureError: any) {
          console.error("\n❌ CAPTURE FAILED:");
          console.error(`Error: ${captureError.message}`);
          
          // Try to get more details about the error
          if (captureError.response) {
            console.error("\nAPI Response Error:");
            console.error(JSON.stringify(captureError.response.data, null, 2));
          }
        }
        
      } else if (authorization.status === "CAPTURED") {
        console.log("\n⚠️  Authorization already captured");
        
        // Check for existing capture
        const capture = orderDetails.purchaseUnits?.[0]?.payments?.captures?.[0];
        if (capture) {
          console.log("\nExisting Capture Details:");
          console.log(`- Capture ID: ${capture.id}`);
          console.log(`- Status: ${capture.status}`);
          console.log(`- Amount: ${capture.amount?.value} ${capture.amount?.currencyCode}`);
          console.log(`- Captured At: ${capture.createTime}`);
        }
        
      } else if (authorization.status === "VOIDED") {
        console.log("\n⚠️  Authorization has been voided and cannot be captured");
        
      } else if (authorization.status === "EXPIRED") {
        console.log("\n⚠️  Authorization has expired and cannot be captured");
        
      } else {
        console.log(`\n⚠️  Unexpected authorization status: ${authorization.status}`);
      }
      
    } else {
      console.log("\n❌ No authorization found for this order");
      
      // Check if it's a direct capture order
      const capture = orderDetails.purchaseUnits?.[0]?.payments?.captures?.[0];
      if (capture) {
        console.log("\nNote: This appears to be a direct CAPTURE intent order:");
        console.log(`- Capture ID: ${capture.id}`);
        console.log(`- Status: ${capture.status}`);
        console.log(`- Amount: ${capture.amount?.value} ${capture.amount?.currencyCode}`);
      }
    }
    
    console.log("\n========================================");
    console.log("Test Complete");
    console.log("========================================");
    
  } catch (error: any) {
    console.error("\n❌ ERROR during test:");
    console.error(error.message);
    
    if (error.response) {
      console.error("\nAPI Response:");
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    
    console.error("\nStack trace:");
    console.error(error.stack);
  }
}

// Run the test
console.log("Starting PayPal capture test...\n");
testCaptureAuthorization()
  .then(() => {
    console.log("\nTest execution completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nUnexpected error:", error);
    process.exit(1);
  });