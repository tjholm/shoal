const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:11434";

function getBackendUrls(): string[] {
  return BACKEND_URL.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default {
  getBackendUrls,
};
