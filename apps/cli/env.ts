const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:11434";

function getBackendUrl(): string {
  return BACKEND_URL;
}

export default {
    getBackendUrl,
}

