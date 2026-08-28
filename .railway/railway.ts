import { bucket, defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const postgresDb = postgres("Postgres", { region: "asia-southeast1-eqsg3a" });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "asia-southeast1-eqsg3a",
    sizeMB: 50000,
  });
  const artifacts = bucket("artifacts", { region: "sin" });
  const backendSource = () => github("gongye19/fed-platform", {
    checkSuites: false,
    rootDirectory: "/backend",
  });

  const fedApi = service("fed-api", {
    source: backendSource(),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["/backend/**"] },
    preDeploy: "fed-migrate",
    healthcheck: "/health",
    healthcheckTimeout: 30,
    deploy: { restartPolicyMaxRetries: 3 },
    replicas: { "asia-southeast1-eqsg3a": 1 },
    env: {
      FEDPLAT_ADMIN_TOKEN: preserve(),
      FEDPLAT_CORS_ORIGINS: "https://fed-console-development.up.railway.app",
      FEDPLAT_DATABASE_URL: preserve(),
      FEDPLAT_MAX_ARTIFACT_BYTES: preserve(),
      FEDPLAT_S3_ACCESS_KEY_ID: preserve(),
      FEDPLAT_S3_BUCKET: preserve(),
      FEDPLAT_S3_ENDPOINT: preserve(),
      FEDPLAT_S3_REGION: preserve(),
      FEDPLAT_S3_SECRET_ACCESS_KEY: preserve(),
      FEDPLAT_S3_URL_STYLE: preserve(),
    },
  });

  const fedWorker = service("fed-worker", {
    source: backendSource(),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["/backend/**"] },
    start: "fed-worker",
    preDeploy: "fed-migrate",
    deploy: { restartPolicyMaxRetries: 3 },
    replicas: { "asia-southeast1-eqsg3a": 1 },
    env: { FEDPLAT_DATABASE_URL: postgresDb.env.DATABASE_URL },
  });

  const fedConsole = service("fed-console", {
    source: github("gongye19/fed-platform", {
      checkSuites: false,
      rootDirectory: "/frontend",
    }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["/frontend/**"] },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    deploy: { restartPolicyMaxRetries: 3 },
    replicas: { "asia-southeast1-eqsg3a": 1 },
    env: { VITE_API_URL: "https://fed-api-development.up.railway.app" },
  });

  return project("fed-platform", {
    resources: [postgresDb, postgresVolume, artifacts, fedApi, fedWorker, fedConsole],
  });
});
