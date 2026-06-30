import { lazy } from "react";

import routes from "./routes";

const ScribeController = lazy(
  () => import("./components/scribe/ScribeController"),
);

const manifest = {
  plugin: "care-eka-scribe-fe",
  routes,
  extends: ["Scribe"],
  components: {
    Scribe: ScribeController,
  },
  devices: [],
} as const;

export default manifest;
