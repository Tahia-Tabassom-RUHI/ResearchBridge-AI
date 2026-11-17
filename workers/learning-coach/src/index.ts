import { createGateway } from "./handlers/gateway";

// Production admission remains closed until persistent quota protection exists.
export default createGateway({ mode: "production" });
