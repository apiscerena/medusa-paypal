import { MedusaError } from "@medusajs/framework/utils";

/**
 * Security utilities for input validation and sanitization
 */

/**
 * Validates and sanitizes a PayPal order ID
 * @param orderId - The order ID to validate
 * @returns The validated order ID
 * @throws MedusaError if the order ID is invalid
 */
export function validateAndSanitizeOrderId(orderId: unknown): string {
  if (!orderId || typeof orderId !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Order ID must be a non-empty string"
    );
  }

  // Remove any potential whitespace
  const trimmedId = orderId.trim();

  // PayPal order IDs are typically 17 alphanumeric characters
  const orderIdPattern = /^[A-Z0-9]{17}$/;
  
  if (!orderIdPattern.test(trimmedId)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Invalid PayPal order ID format"
    );
  }

  return trimmedId;
}

/**
 * Validates and sanitizes a PayPal authorization ID
 * @param authId - The authorization ID to validate
 * @returns The validated authorization ID
 * @throws MedusaError if the authorization ID is invalid
 */
export function validateAndSanitizeAuthorizationId(authId: unknown): string {
  if (!authId || typeof authId !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Authorization ID must be a non-empty string"
    );
  }

  // Remove any potential whitespace
  const trimmedId = authId.trim();

  // PayPal authorization IDs are typically 17-20 alphanumeric characters
  const authIdPattern = /^[A-Z0-9]{17,20}$/;
  
  if (!authIdPattern.test(trimmedId)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Invalid PayPal authorization ID format"
    );
  }

  return trimmedId;
}

/**
 * Validates and sanitizes a PayPal capture ID
 * @param captureId - The capture ID to validate
 * @returns The validated capture ID
 * @throws MedusaError if the capture ID is invalid
 */
export function validateAndSanitizeCaptureId(captureId: unknown): string {
  if (!captureId || typeof captureId !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Capture ID must be a non-empty string"
    );
  }

  // Remove any potential whitespace
  const trimmedId = captureId.trim();

  // PayPal capture IDs are typically 17-20 alphanumeric characters
  const captureIdPattern = /^[A-Z0-9]{17,20}$/;
  
  if (!captureIdPattern.test(trimmedId)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Invalid PayPal capture ID format"
    );
  }

  return trimmedId;
}

/**
 * Sanitizes user input to prevent XSS and injection attacks
 * @param input - The input to sanitize
 * @returns The sanitized input
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }

  // Remove HTML tags and special characters that could be used for injection
  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/['"]/g, '') // Remove quotes
    .replace(/[&]/g, '&amp;') // Escape ampersands
    .replace(/[\r\n]/g, ' ') // Replace newlines with spaces
    .trim();
}

/**
 * Validates email format
 * @param email - The email to validate
 * @returns True if valid, false otherwise
 */
export function isValidEmail(email: string): boolean {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailPattern.test(email);
}

/**
 * Rate limiting helper class
 */
export class RateLimiter {
  private store: Map<string, { count: number; resetTime: number }>;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number = 10, windowMs: number = 60000) {
    this.store = new Map();
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Check if a client has exceeded the rate limit
   * @param clientId - Unique identifier for the client
   * @returns True if rate limit exceeded, false otherwise
   */
  isRateLimited(clientId: string): boolean {
    const now = Date.now();
    const clientData = this.store.get(clientId);

    if (!clientData) {
      this.store.set(clientId, { count: 1, resetTime: now + this.windowMs });
      return false;
    }

    if (now > clientData.resetTime) {
      // Window has expired, reset
      this.store.set(clientId, { count: 1, resetTime: now + this.windowMs });
      return false;
    }

    // Within window
    if (clientData.count >= this.limit) {
      return true;
    }

    clientData.count++;
    return false;
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.store.entries()) {
      if (now > value.resetTime) {
        this.store.delete(key);
      }
    }
  }
}