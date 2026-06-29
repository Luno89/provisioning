// https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs
// generated from terraform resource schema
import * as cdktf from 'cdktf';
export function helmProviderExperimentsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        manifest: cdktf.booleanToTerraform(struct.manifest),
    };
}
export function helmProviderExperimentsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        manifest: {
            value: cdktf.booleanToHclTerraform(struct.manifest),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export function helmProviderKubernetesExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        api_version: cdktf.stringToTerraform(struct.apiVersion),
        args: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.args),
        command: cdktf.stringToTerraform(struct.command),
        env: cdktf.hashMapper(cdktf.stringToTerraform)(struct.env),
    };
}
export function helmProviderKubernetesExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        api_version: {
            value: cdktf.stringToHclTerraform(struct.apiVersion),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        args: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.args),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        command: {
            value: cdktf.stringToHclTerraform(struct.command),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        env: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.env),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export function helmProviderKubernetesToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        client_certificate: cdktf.stringToTerraform(struct.clientCertificate),
        client_key: cdktf.stringToTerraform(struct.clientKey),
        cluster_ca_certificate: cdktf.stringToTerraform(struct.clusterCaCertificate),
        config_context: cdktf.stringToTerraform(struct.configContext),
        config_context_auth_info: cdktf.stringToTerraform(struct.configContextAuthInfo),
        config_context_cluster: cdktf.stringToTerraform(struct.configContextCluster),
        config_path: cdktf.stringToTerraform(struct.configPath),
        config_paths: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.configPaths),
        host: cdktf.stringToTerraform(struct.host),
        insecure: cdktf.booleanToTerraform(struct.insecure),
        password: cdktf.stringToTerraform(struct.password),
        proxy_url: cdktf.stringToTerraform(struct.proxyUrl),
        tls_server_name: cdktf.stringToTerraform(struct.tlsServerName),
        token: cdktf.stringToTerraform(struct.token),
        username: cdktf.stringToTerraform(struct.username),
        exec: helmProviderKubernetesExecToTerraform(struct.exec),
    };
}
export function helmProviderKubernetesToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        client_certificate: {
            value: cdktf.stringToHclTerraform(struct.clientCertificate),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        client_key: {
            value: cdktf.stringToHclTerraform(struct.clientKey),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        cluster_ca_certificate: {
            value: cdktf.stringToHclTerraform(struct.clusterCaCertificate),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        config_context: {
            value: cdktf.stringToHclTerraform(struct.configContext),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        config_context_auth_info: {
            value: cdktf.stringToHclTerraform(struct.configContextAuthInfo),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        config_context_cluster: {
            value: cdktf.stringToHclTerraform(struct.configContextCluster),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        config_path: {
            value: cdktf.stringToHclTerraform(struct.configPath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        config_paths: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.configPaths),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        insecure: {
            value: cdktf.booleanToHclTerraform(struct.insecure),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        password: {
            value: cdktf.stringToHclTerraform(struct.password),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        proxy_url: {
            value: cdktf.stringToHclTerraform(struct.proxyUrl),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        tls_server_name: {
            value: cdktf.stringToHclTerraform(struct.tlsServerName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        token: {
            value: cdktf.stringToHclTerraform(struct.token),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        username: {
            value: cdktf.stringToHclTerraform(struct.username),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        exec: {
            value: helmProviderKubernetesExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "HelmProviderKubernetesExecList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export function helmProviderRegistryToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        password: cdktf.stringToTerraform(struct.password),
        url: cdktf.stringToTerraform(struct.url),
        username: cdktf.stringToTerraform(struct.username),
    };
}
export function helmProviderRegistryToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        password: {
            value: cdktf.stringToHclTerraform(struct.password),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        url: {
            value: cdktf.stringToHclTerraform(struct.url),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        username: {
            value: cdktf.stringToHclTerraform(struct.username),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs helm}
*/
export class HelmProvider extends cdktf.TerraformProvider {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "helm";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a HelmProvider resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the HelmProvider to import
    * @param importFromId The id of the existing HelmProvider that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the HelmProvider to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "helm", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs helm} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options HelmProviderConfig = {}
    */
    constructor(scope, id, config = {}) {
        super(scope, id, {
            terraformResourceType: 'helm',
            terraformGeneratorMetadata: {
                providerName: 'helm',
                providerVersion: '2.17.0',
                providerVersionConstraint: '~> 2.0'
            },
            terraformProviderSource: 'hashicorp/helm'
        });
        this._burstLimit = config.burstLimit;
        this._debug = config.debug;
        this._helmDriver = config.helmDriver;
        this._pluginsPath = config.pluginsPath;
        this._registryConfigPath = config.registryConfigPath;
        this._repositoryCache = config.repositoryCache;
        this._repositoryConfigPath = config.repositoryConfigPath;
        this._alias = config.alias;
        this._experiments = config.experiments;
        this._kubernetes = config.kubernetes;
        this._registry = config.registry;
    }
    // ==========
    // ATTRIBUTES
    // ==========
    // burst_limit - computed: false, optional: true, required: false
    _burstLimit;
    get burstLimit() {
        return this._burstLimit;
    }
    set burstLimit(value) {
        this._burstLimit = value;
    }
    resetBurstLimit() {
        this._burstLimit = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get burstLimitInput() {
        return this._burstLimit;
    }
    // debug - computed: false, optional: true, required: false
    _debug;
    get debug() {
        return this._debug;
    }
    set debug(value) {
        this._debug = value;
    }
    resetDebug() {
        this._debug = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get debugInput() {
        return this._debug;
    }
    // helm_driver - computed: false, optional: true, required: false
    _helmDriver;
    get helmDriver() {
        return this._helmDriver;
    }
    set helmDriver(value) {
        this._helmDriver = value;
    }
    resetHelmDriver() {
        this._helmDriver = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get helmDriverInput() {
        return this._helmDriver;
    }
    // plugins_path - computed: false, optional: true, required: false
    _pluginsPath;
    get pluginsPath() {
        return this._pluginsPath;
    }
    set pluginsPath(value) {
        this._pluginsPath = value;
    }
    resetPluginsPath() {
        this._pluginsPath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pluginsPathInput() {
        return this._pluginsPath;
    }
    // registry_config_path - computed: false, optional: true, required: false
    _registryConfigPath;
    get registryConfigPath() {
        return this._registryConfigPath;
    }
    set registryConfigPath(value) {
        this._registryConfigPath = value;
    }
    resetRegistryConfigPath() {
        this._registryConfigPath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get registryConfigPathInput() {
        return this._registryConfigPath;
    }
    // repository_cache - computed: false, optional: true, required: false
    _repositoryCache;
    get repositoryCache() {
        return this._repositoryCache;
    }
    set repositoryCache(value) {
        this._repositoryCache = value;
    }
    resetRepositoryCache() {
        this._repositoryCache = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryCacheInput() {
        return this._repositoryCache;
    }
    // repository_config_path - computed: false, optional: true, required: false
    _repositoryConfigPath;
    get repositoryConfigPath() {
        return this._repositoryConfigPath;
    }
    set repositoryConfigPath(value) {
        this._repositoryConfigPath = value;
    }
    resetRepositoryConfigPath() {
        this._repositoryConfigPath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryConfigPathInput() {
        return this._repositoryConfigPath;
    }
    // alias - computed: false, optional: true, required: false
    _alias;
    get alias() {
        return this._alias;
    }
    set alias(value) {
        this._alias = value;
    }
    resetAlias() {
        this._alias = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get aliasInput() {
        return this._alias;
    }
    // experiments - computed: false, optional: true, required: false
    _experiments;
    get experiments() {
        return this._experiments;
    }
    set experiments(value) {
        this._experiments = value;
    }
    resetExperiments() {
        this._experiments = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get experimentsInput() {
        return this._experiments;
    }
    // kubernetes - computed: false, optional: true, required: false
    _kubernetes;
    get kubernetes() {
        return this._kubernetes;
    }
    set kubernetes(value) {
        this._kubernetes = value;
    }
    resetKubernetes() {
        this._kubernetes = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get kubernetesInput() {
        return this._kubernetes;
    }
    // registry - computed: false, optional: true, required: false
    _registry;
    get registry() {
        return this._registry;
    }
    set registry(value) {
        this._registry = value;
    }
    resetRegistry() {
        this._registry = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get registryInput() {
        return this._registry;
    }
    // =========
    // SYNTHESIS
    // =========
    synthesizeAttributes() {
        return {
            burst_limit: cdktf.numberToTerraform(this._burstLimit),
            debug: cdktf.booleanToTerraform(this._debug),
            helm_driver: cdktf.stringToTerraform(this._helmDriver),
            plugins_path: cdktf.stringToTerraform(this._pluginsPath),
            registry_config_path: cdktf.stringToTerraform(this._registryConfigPath),
            repository_cache: cdktf.stringToTerraform(this._repositoryCache),
            repository_config_path: cdktf.stringToTerraform(this._repositoryConfigPath),
            alias: cdktf.stringToTerraform(this._alias),
            experiments: helmProviderExperimentsToTerraform(this._experiments),
            kubernetes: helmProviderKubernetesToTerraform(this._kubernetes),
            registry: cdktf.listMapper(helmProviderRegistryToTerraform, true)(this._registry),
        };
    }
    synthesizeHclAttributes() {
        const attrs = {
            burst_limit: {
                value: cdktf.numberToHclTerraform(this._burstLimit),
                isBlock: false,
                type: "simple",
                storageClassType: "number",
            },
            debug: {
                value: cdktf.booleanToHclTerraform(this._debug),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            helm_driver: {
                value: cdktf.stringToHclTerraform(this._helmDriver),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            plugins_path: {
                value: cdktf.stringToHclTerraform(this._pluginsPath),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            registry_config_path: {
                value: cdktf.stringToHclTerraform(this._registryConfigPath),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            repository_cache: {
                value: cdktf.stringToHclTerraform(this._repositoryCache),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            repository_config_path: {
                value: cdktf.stringToHclTerraform(this._repositoryConfigPath),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            alias: {
                value: cdktf.stringToHclTerraform(this._alias),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            experiments: {
                value: helmProviderExperimentsToHclTerraform(this._experiments),
                isBlock: true,
                type: "list",
                storageClassType: "HelmProviderExperimentsList",
            },
            kubernetes: {
                value: helmProviderKubernetesToHclTerraform(this._kubernetes),
                isBlock: true,
                type: "list",
                storageClassType: "HelmProviderKubernetesList",
            },
            registry: {
                value: cdktf.listMapperHcl(helmProviderRegistryToHclTerraform, true)(this._registry),
                isBlock: true,
                type: "list",
                storageClassType: "HelmProviderRegistryList",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
