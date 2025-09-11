# PayPal Authorization Capture Implementation

## Overview

This document describes the implementation of PayPal's AUTHORIZE intent payment capture flow in the Medusa PayPal plugin, including the issues encountered, solutions implemented, and verification process.

## Problem Statement

### Initial Issue
The Medusa PayPal plugin was failing to properly capture payments when using the `AUTHORIZE` intent. When administrators clicked "Capture" in the Medusa admin dashboard, the payment appeared captured in the UI but wasn't actually captured on PayPal's side.

### Root Cause
The plugin was using incorrect PayPal API calls for the authorization flow:
1. Attempting to capture orders directly instead of capturing authorizations
2. Checking for `captures` instead of `authorizations` in the payment status

## Solution Implementation

### 1. Core Fix: Authorization Capture Logic

**File**: `src/providers/paypal/paypal-core/paypal-core.ts`

#### Before (Incorrect)
```typescript
async captureOrder(id: string): Promise<Order> {
  // Incorrectly trying to capture order directly
  const capturedOrder = await this.ordersController.captureOrder({ id });
  return capturedOrder.result;
}
```

#### After (Correct)
```typescript
async captureOrder(id: string): Promise<Order> {
  const orderDetails = await this.retrieveOrder(id);
  
  // Check for authorization that needs to be captured
  const authorization = orderDetails.purchaseUnits?.[0]?.payments?.authorizations?.[0];
  
  if (authorization && authorization.status === "CREATED") {
    // Capture the authorization using the correct SDK method
    const capturedPayment = await this.captureAuthorization(authorization.id);
    return await this.retrieveOrder(id);
  }
  
  // Handle other cases...
}

async captureAuthorization(authorizationId: string): Promise<any> {
  // Use the correct PayPal SDK method for capturing authorizations
  const capturedPayment = await this.paymentsController.captureAuthorizedPayment({
    authorizationId,
  });
  return capturedPayment.result;
}
```

### 2. Status Checking Fix

**File**: `src/providers/paypal/service.ts`

#### Before (Incorrect)
```typescript
const captureData = paypalData.purchaseUnits?.[0].payments?.captures?.[0];
```

#### After (Correct)
```typescript
const authorizationData = paypalData.purchaseUnits?.[0].payments?.authorizations?.[0];
```

## PayPal API Flow

### Correct Authorization Flow

1. **Create Order** (intent=AUTHORIZE)
   - `POST /v2/checkout/orders`
   - Status: CREATED

2. **Buyer Approves**
   - Customer completes checkout
   - Status: APPROVED

3. **Authorize Order**
   - `POST /v2/checkout/orders/{order_id}/authorize`
   - Creates authorization with status: CREATED

4. **Capture Authorization**
   - `POST /v2/payments/authorizations/{authorization_id}/capture`
   - Captures funds from the authorization

### Key Differences Between Intents

| Intent | API Method | Capture Endpoint |
|--------|------------|------------------|
| CAPTURE | `captureOrder()` | `/v2/checkout/orders/{id}/capture` |
| AUTHORIZE | `captureAuthorizedPayment()` | `/v2/payments/authorizations/{id}/capture` |

## Enhanced Features

### 1. Detailed Logging

Added comprehensive logging for debugging payment flows:

```typescript
console.log(`[PayPal] Order ${id} status: ${orderDetails.status}`);
console.log(`[PayPal] Found authorization:`, {
  id: authorization.id,
  status: authorization.status,
  amount: authorization.amount,
});
console.log(`[PayPal] Capture response:`, JSON.stringify(capturedPayment.result, null, 2));
```

### 2. Error Handling

Improved error handling with context:

```typescript
try {
  const capturedPayment = await this.captureAuthorization(authorization.id);
  // ...
} catch (captureError: any) {
  console.error(`[PayPal] Failed to capture authorization:`, captureError);
  throw new Error(`Failed to capture PayPal authorization ${authorization.id}: ${captureError.message}`);
}
```

### 3. Edge Case Handling

- Already captured payments
- Mixed CAPTURE/AUTHORIZE intents
- Invalid authorization status
- Expired authorizations

## Medusa Integration

### How Medusa Calls the PayPal Plugin

1. **Admin Action**: Administrator clicks "Capture" in Medusa admin
2. **API Route**: `POST /api/admin/payments/[id]/capture`
3. **Workflow**: `capturePaymentWorkflow`
4. **Payment Module**: `paymentModule.capturePayment(input)`
5. **Plugin Method**: `PayPalProvider.capturePayment(input)`

### Parameter Flow

```typescript
// Medusa sends
{
  payment_id: "pay_01K4SRP7...",  // Medusa Payment ID
  amount?: 1000,                   // Optional capture amount
  captured_by?: "user_123"         // Who triggered the capture
}

// Plugin receives in input.data
{
  id: "3HK18464JF175351X",        // PayPal Order ID
  status: "APPROVED",
  // ... other PayPal order data
}
```

## Testing

### Test Scripts

Two test scripts have been created:

1. **test/test-capture.ts**: Tests capture via Order ID (normal flow)
2. **test/test-capture-auth.ts**: Tests direct authorization capture

### Running Tests

```bash
# Test with Order ID
npm run test:capture

# Test with Authorization ID directly
npx ts-node test/test-capture-auth.ts
```

### Successful Test Output

```
✅ SUCCESS: Authorization captured!
Capture ID: 3R932354UA4911357
Status: COMPLETED
```

## Security Enhancements

### 1. Input Validation

Added validation for PayPal IDs:

```typescript
private validatePayPalOrderId(orderId: string): boolean {
  const orderIdPattern = /^[A-Z0-9]{17}$/;
  return orderIdPattern.test(orderId);
}
```

### 2. Rate Limiting

Implemented rate limiting for API endpoints:

```typescript
const rateLimiter = new RateLimiter(10, 60000);
if (rateLimiter.isRateLimited(clientKey)) {
  return res.status(429).json({ error: "Too many requests" });
}
```

### 3. Webhook Verification

Added signature verification for PayPal webhooks:

```typescript
const verifyWebhookRes = await fetch(
  `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
  {
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
  }
);
```

## Decimal Precision Fix

### Issue
PayPal API requires exactly 2 decimal places for amounts.

### Solution
Added `formatAmount()` method:

```typescript
private formatAmount(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return rounded.toFixed(2);
}
```

## Version History

- **v0.3.2**: Initial security fixes
- **v0.3.3**: Decimal precision fix
- **v0.4.0**: Authorization capture flow implementation
- **v0.4.1**: Dependency updates
- **v0.4.2**: Enhanced logging and error handling
- **v0.4.3**: Documentation and test organization

## References

- [PayPal Authorization and Capture Guide](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)
- [PayPal Orders API v2](https://developer.paypal.com/docs/api/orders/v2/)
- [PayPal Payments API v2](https://developer.paypal.com/docs/api/payments/v2/)
- [Medusa Payment Module Documentation](https://docs.medusajs.com/resources/commerce-modules/payment)

## Support

For issues or questions, please open an issue at: https://github.com/apiscerena/medusa-paypal/issues