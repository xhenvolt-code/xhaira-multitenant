import { AsyncLocalStorage } from 'node:async_hooks';

const organizationContext = new AsyncLocalStorage();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getOrganizationContext() {
  return organizationContext.getStore() || null;
}

export function enterOrganizationContext(organizationId) {
  if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
    throw new TypeError('A valid organization ID is required for database access');
  }
  organizationContext.enterWith(organizationId);
}

export function runWithOrganizationContext(organizationId, callback) {
  if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
    throw new TypeError('A valid organization ID is required for database access');
  }
  return organizationContext.run(organizationId, callback);
}

export function clearOrganizationContext() {
  organizationContext.enterWith(null);
}