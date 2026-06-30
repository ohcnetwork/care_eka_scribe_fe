import "./index.css";

export { default as manifest } from "./manifest";
export { default as routes } from "./routes";
export { ScribeController } from "./components/scribe";

declare global {
  interface Window {
    CARE_API_URL: string;
  }
}

export const CARE_API_URL = window.CARE_API_URL;
