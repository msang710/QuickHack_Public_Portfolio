const services = new Set();

export function registerQhkeyCredentialStateService(service) {
  if (!service || typeof service.clear !== "function") {
    throw new TypeError("A QHKEY credential state service is required.");
  }
  services.add(service);
}

export function clearAllQhkeyCredentialStateCaches() {
  for (const service of services) service.clear();
}
