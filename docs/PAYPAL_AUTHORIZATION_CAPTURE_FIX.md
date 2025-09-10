# PayPal Authorization Capture Flow Fix

## Problem Statement

The Medusa PayPal plugin was failing to properly capture payments when using the `AUTHORIZE` intent. After clicking "Capture" in the Medusa admin dashboard, the payment appeared captured in the UI but wasn't actually captured on PayPal's side.

## Root Cause Analysis

### Investigation Process

Following a hypothesis-validation methodology, the issue was investigated systematically:

1. **Initial Hypothesis**: The plugin was using incorrect PayPal API calls for the authorization flow
2. **Validation Method**: 
   - Reviewed PayPal official documentation (2024)
   - Analyzed PayPal SDK source code
   - Created test scripts to verify API call sequences
3. **Evidence Gathered**: Confirmed that the plugin was incorrectly attempting to capture orders directly instead of capturing authorizations

### Technical Issues Identified

1. **In `paypal-core.ts`**:
   - The `captureOrder()` method was calling `ordersController.captureOrder()` directly
   - This approach only works for `CAPTURE` intent orders, not `AUTHORIZE` intent orders

2. **In `service.ts`**:
   - The `authorizePayment()` method was checking for `captures` instead of `authorizations`
   - This caused incorrect status checking and error handling

## PayPal Authorization Flow

### Correct API Sequence for AUTHORIZE Intent

Based on PayPal's official documentation, the correct flow is:

```
1. Create Order (intent=AUTHORIZE)
   → POST /v2/checkout/orders
   → Status: CREATED

2. Buyer Approves Order
   → Customer completes checkout
   → Status: APPROVED

3. Authorize Order
   → POST /v2/checkout/orders/{order_id}/authorize
   → Creates authorization with status: CREATED

4. Capture Authorization
   → POST /v2/payments/authorizations/{authorization_id}/capture
   → Captures funds from the authorization
```

### Key Differences Between Intents

| Intent | Direct Capture | Authorization Required | Capture Method |
|--------|---------------|----------------------|----------------|
| CAPTURE | Yes | No | `captureOrder()` |
| AUTHORIZE | No | Yes | `captureAuthorizedPayment()` |

## Implementation Solution

### 1. Enhanced `captureOrder()` Method

The method now intelligently handles both intent types:

```typescript
async captureOrder(id: string): Promise<Order> {
  const orderDetails = await this.retrieveOrder(id);
  
  // For AUTHORIZE intent - capture the authorization
  const authorization = orderDetails.purchaseUnits?.[0]?.payments?.authorizations?.[0];
  if (authorization && authorization.status === "CREATED") {
    const capturedPayment = await this.captureAuthorization(authorization.id);
    return await this.retrieveOrder(id);
  }
  
  // For CAPTURE intent - direct capture
  if (orderDetails.intent === "CAPTURE" && orderDetails.status === "APPROVED") {
    const capturedOrder = await this.ordersController.captureOrder({ id });
    return capturedOrder.result;
  }
  
  // Handle edge cases...
}
```

### 2. New `captureAuthorization()` Method

Added proper authorization capture using the PayPal SDK:

```typescript
async captureAuthorization(authorizationId: string): Promise<any> {
  const capturedPayment = await this.paymentsController.captureAuthorizedPayment({
    authorizationId,
  });
  return capturedPayment.result;
}
```

### 3. Fixed Authorization Status Checking

Updated the `authorizePayment()` method to check the correct payment object:

```typescript
// Before (incorrect):
const captureData = paypalData.purchaseUnits?.[0].payments?.captures?.[0];

// After (correct):
const authorizationData = paypalData.purchaseUnits?.[0].payments?.authorizations?.[0];
```

## Testing & Verification

### Manual Testing Steps

1. Create an order with PayPal payment
2. Complete PayPal checkout as buyer
3. In Medusa admin, click "Capture" on the payment
4. Verify in PayPal dashboard that funds are actually captured

### Expected Behavior

- Order status progression: `CREATED` → `APPROVED` → `COMPLETED`
- Authorization created after buyer approval
- Successful capture of authorization when admin clicks "Capture"
- Proper error handling for edge cases (already captured, invalid status, etc.)

## Debugging & Monitoring

Added comprehensive logging to track the payment flow:

```typescript
console.log(`[PayPal] Order ${id} status: ${orderDetails.status}`);
console.log(`[PayPal] Capturing authorization ${authorization.id} for order ${id}`);
console.log(`[PayPal] Order ${id} already has completed capture`);
```

These logs help identify:
- Current order status
- Which code path is being executed
- Whether authorization or direct capture is being used

## Edge Cases Handled

1. **Already Captured**: Check if order already has a completed capture
2. **Mixed Intents**: Support both AUTHORIZE and CAPTURE intent orders
3. **Missing Authorization**: Proper error messages when authorization is missing
4. **Status Validation**: Verify order is in correct status before capture attempt

## References

- [PayPal Authorization and Capture Guide](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)
- [PayPal Orders API v2 Reference](https://developer.paypal.com/docs/api/orders/v2/)
- [PayPal Payments API v2 Reference](https://developer.paypal.com/docs/api/payments/v2/)

## Conclusion

The fix ensures that the Medusa PayPal plugin correctly handles both `AUTHORIZE` and `CAPTURE` intent orders by:
1. Using the appropriate SDK methods for each intent type
2. Properly checking authorization status instead of capture status
3. Following PayPal's documented API flow for authorization and capture
4. Adding comprehensive error handling and logging

This resolves the issue where payments appeared captured in Medusa but weren't actually captured on PayPal's side.