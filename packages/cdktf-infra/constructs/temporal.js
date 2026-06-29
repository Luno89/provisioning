import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
export class TemporalApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "temporal";
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const enableBackend = config.enableBackend !== false;
        const helmValues = [
            { name: "enableBackend", value: String(enableBackend) },
        ];
        if (config.image) {
            helmValues.push({ name: "image.repository", value: config.image });
        }
        new Release(this, "temporal-release", {
            name: "temporal",
            repository: "https://temporal.io/charts",
            chart: "temporal",
            namespace: ns.metadata.name,
            timeout: 600,
            set: helmValues,
        });
    }
}
