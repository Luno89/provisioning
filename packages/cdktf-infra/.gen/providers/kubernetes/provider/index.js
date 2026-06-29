// https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs
// generated from terraform resource schema
import * as cdktf from 'cdktf';
export function kubernetesProviderExecToTerraform(struct) {
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
export function kubernetesProviderExecToHclTerraform(struct) {
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
export function kubernetesProviderExperimentsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        manifest_resource: cdktf.booleanToTerraform(struct.manifestResource),
    };
}
export function kubernetesProviderExperimentsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        manifest_resource: {
            value: cdktf.booleanToHclTerraform(struct.manifestResource),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs kubernetes}
*/
export class KubernetesProvider extends cdktf.TerraformProvider {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "kubernetes";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a KubernetesProvider resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the KubernetesProvider to import
    * @param importFromId The id of the existing KubernetesProvider that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the KubernetesProvider to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "kubernetes", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs kubernetes} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options KubernetesProviderConfig = {}
    */
    constructor(scope, id, config = {}) {
        super(scope, id, {
            terraformResourceType: 'kubernetes',
            terraformGeneratorMetadata: {
                providerName: 'kubernetes',
                providerVersion: '2.38.0',
                providerVersionConstraint: '~> 2.0'
            },
            terraformProviderSource: 'hashicorp/kubernetes'
        });
        this._clientCertificate = config.clientCertificate;
        this._clientKey = config.clientKey;
        this._clusterCaCertificate = config.clusterCaCertificate;
        this._configContext = config.configContext;
        this._configContextAuthInfo = config.configContextAuthInfo;
        this._configContextCluster = config.configContextCluster;
        this._configPath = config.configPath;
        this._configPaths = config.configPaths;
        this._host = config.host;
        this._ignoreAnnotations = config.ignoreAnnotations;
        this._ignoreLabels = config.ignoreLabels;
        this._insecure = config.insecure;
        this._password = config.password;
        this._proxyUrl = config.proxyUrl;
        this._tlsServerName = config.tlsServerName;
        this._token = config.token;
        this._username = config.username;
        this._alias = config.alias;
        this._exec = config.exec;
        this._experiments = config.experiments;
    }
    // ==========
    // ATTRIBUTES
    // ==========
    // client_certificate - computed: false, optional: true, required: false
    _clientCertificate;
    get clientCertificate() {
        return this._clientCertificate;
    }
    set clientCertificate(value) {
        this._clientCertificate = value;
    }
    resetClientCertificate() {
        this._clientCertificate = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get clientCertificateInput() {
        return this._clientCertificate;
    }
    // client_key - computed: false, optional: true, required: false
    _clientKey;
    get clientKey() {
        return this._clientKey;
    }
    set clientKey(value) {
        this._clientKey = value;
    }
    resetClientKey() {
        this._clientKey = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get clientKeyInput() {
        return this._clientKey;
    }
    // cluster_ca_certificate - computed: false, optional: true, required: false
    _clusterCaCertificate;
    get clusterCaCertificate() {
        return this._clusterCaCertificate;
    }
    set clusterCaCertificate(value) {
        this._clusterCaCertificate = value;
    }
    resetClusterCaCertificate() {
        this._clusterCaCertificate = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get clusterCaCertificateInput() {
        return this._clusterCaCertificate;
    }
    // config_context - computed: false, optional: true, required: false
    _configContext;
    get configContext() {
        return this._configContext;
    }
    set configContext(value) {
        this._configContext = value;
    }
    resetConfigContext() {
        this._configContext = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configContextInput() {
        return this._configContext;
    }
    // config_context_auth_info - computed: false, optional: true, required: false
    _configContextAuthInfo;
    get configContextAuthInfo() {
        return this._configContextAuthInfo;
    }
    set configContextAuthInfo(value) {
        this._configContextAuthInfo = value;
    }
    resetConfigContextAuthInfo() {
        this._configContextAuthInfo = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configContextAuthInfoInput() {
        return this._configContextAuthInfo;
    }
    // config_context_cluster - computed: false, optional: true, required: false
    _configContextCluster;
    get configContextCluster() {
        return this._configContextCluster;
    }
    set configContextCluster(value) {
        this._configContextCluster = value;
    }
    resetConfigContextCluster() {
        this._configContextCluster = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configContextClusterInput() {
        return this._configContextCluster;
    }
    // config_path - computed: false, optional: true, required: false
    _configPath;
    get configPath() {
        return this._configPath;
    }
    set configPath(value) {
        this._configPath = value;
    }
    resetConfigPath() {
        this._configPath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configPathInput() {
        return this._configPath;
    }
    // config_paths - computed: false, optional: true, required: false
    _configPaths;
    get configPaths() {
        return this._configPaths;
    }
    set configPaths(value) {
        this._configPaths = value;
    }
    resetConfigPaths() {
        this._configPaths = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configPathsInput() {
        return this._configPaths;
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this._host;
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // ignore_annotations - computed: false, optional: true, required: false
    _ignoreAnnotations;
    get ignoreAnnotations() {
        return this._ignoreAnnotations;
    }
    set ignoreAnnotations(value) {
        this._ignoreAnnotations = value;
    }
    resetIgnoreAnnotations() {
        this._ignoreAnnotations = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get ignoreAnnotationsInput() {
        return this._ignoreAnnotations;
    }
    // ignore_labels - computed: false, optional: true, required: false
    _ignoreLabels;
    get ignoreLabels() {
        return this._ignoreLabels;
    }
    set ignoreLabels(value) {
        this._ignoreLabels = value;
    }
    resetIgnoreLabels() {
        this._ignoreLabels = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get ignoreLabelsInput() {
        return this._ignoreLabels;
    }
    // insecure - computed: false, optional: true, required: false
    _insecure;
    get insecure() {
        return this._insecure;
    }
    set insecure(value) {
        this._insecure = value;
    }
    resetInsecure() {
        this._insecure = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get insecureInput() {
        return this._insecure;
    }
    // password - computed: false, optional: true, required: false
    _password;
    get password() {
        return this._password;
    }
    set password(value) {
        this._password = value;
    }
    resetPassword() {
        this._password = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get passwordInput() {
        return this._password;
    }
    // proxy_url - computed: false, optional: true, required: false
    _proxyUrl;
    get proxyUrl() {
        return this._proxyUrl;
    }
    set proxyUrl(value) {
        this._proxyUrl = value;
    }
    resetProxyUrl() {
        this._proxyUrl = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get proxyUrlInput() {
        return this._proxyUrl;
    }
    // tls_server_name - computed: false, optional: true, required: false
    _tlsServerName;
    get tlsServerName() {
        return this._tlsServerName;
    }
    set tlsServerName(value) {
        this._tlsServerName = value;
    }
    resetTlsServerName() {
        this._tlsServerName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tlsServerNameInput() {
        return this._tlsServerName;
    }
    // token - computed: false, optional: true, required: false
    _token;
    get token() {
        return this._token;
    }
    set token(value) {
        this._token = value;
    }
    resetToken() {
        this._token = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tokenInput() {
        return this._token;
    }
    // username - computed: false, optional: true, required: false
    _username;
    get username() {
        return this._username;
    }
    set username(value) {
        this._username = value;
    }
    resetUsername() {
        this._username = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get usernameInput() {
        return this._username;
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
    // exec - computed: false, optional: true, required: false
    _exec;
    get exec() {
        return this._exec;
    }
    set exec(value) {
        this._exec = value;
    }
    resetExec() {
        this._exec = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec;
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
    // =========
    // SYNTHESIS
    // =========
    synthesizeAttributes() {
        return {
            client_certificate: cdktf.stringToTerraform(this._clientCertificate),
            client_key: cdktf.stringToTerraform(this._clientKey),
            cluster_ca_certificate: cdktf.stringToTerraform(this._clusterCaCertificate),
            config_context: cdktf.stringToTerraform(this._configContext),
            config_context_auth_info: cdktf.stringToTerraform(this._configContextAuthInfo),
            config_context_cluster: cdktf.stringToTerraform(this._configContextCluster),
            config_path: cdktf.stringToTerraform(this._configPath),
            config_paths: cdktf.listMapper(cdktf.stringToTerraform, false)(this._configPaths),
            host: cdktf.stringToTerraform(this._host),
            ignore_annotations: cdktf.listMapper(cdktf.stringToTerraform, false)(this._ignoreAnnotations),
            ignore_labels: cdktf.listMapper(cdktf.stringToTerraform, false)(this._ignoreLabels),
            insecure: cdktf.booleanToTerraform(this._insecure),
            password: cdktf.stringToTerraform(this._password),
            proxy_url: cdktf.stringToTerraform(this._proxyUrl),
            tls_server_name: cdktf.stringToTerraform(this._tlsServerName),
            token: cdktf.stringToTerraform(this._token),
            username: cdktf.stringToTerraform(this._username),
            alias: cdktf.stringToTerraform(this._alias),
            exec: cdktf.listMapper(kubernetesProviderExecToTerraform, true)(this._exec),
            experiments: cdktf.listMapper(kubernetesProviderExperimentsToTerraform, true)(this._experiments),
        };
    }
    synthesizeHclAttributes() {
        const attrs = {
            client_certificate: {
                value: cdktf.stringToHclTerraform(this._clientCertificate),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            client_key: {
                value: cdktf.stringToHclTerraform(this._clientKey),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            cluster_ca_certificate: {
                value: cdktf.stringToHclTerraform(this._clusterCaCertificate),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            config_context: {
                value: cdktf.stringToHclTerraform(this._configContext),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            config_context_auth_info: {
                value: cdktf.stringToHclTerraform(this._configContextAuthInfo),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            config_context_cluster: {
                value: cdktf.stringToHclTerraform(this._configContextCluster),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            config_path: {
                value: cdktf.stringToHclTerraform(this._configPath),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            config_paths: {
                value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(this._configPaths),
                isBlock: false,
                type: "list",
                storageClassType: "stringList",
            },
            host: {
                value: cdktf.stringToHclTerraform(this._host),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            ignore_annotations: {
                value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(this._ignoreAnnotations),
                isBlock: false,
                type: "list",
                storageClassType: "stringList",
            },
            ignore_labels: {
                value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(this._ignoreLabels),
                isBlock: false,
                type: "list",
                storageClassType: "stringList",
            },
            insecure: {
                value: cdktf.booleanToHclTerraform(this._insecure),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            password: {
                value: cdktf.stringToHclTerraform(this._password),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            proxy_url: {
                value: cdktf.stringToHclTerraform(this._proxyUrl),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            tls_server_name: {
                value: cdktf.stringToHclTerraform(this._tlsServerName),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            token: {
                value: cdktf.stringToHclTerraform(this._token),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            username: {
                value: cdktf.stringToHclTerraform(this._username),
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
            exec: {
                value: cdktf.listMapperHcl(kubernetesProviderExecToHclTerraform, true)(this._exec),
                isBlock: true,
                type: "list",
                storageClassType: "KubernetesProviderExecList",
            },
            experiments: {
                value: cdktf.listMapperHcl(kubernetesProviderExperimentsToHclTerraform, true)(this._experiments),
                isBlock: true,
                type: "list",
                storageClassType: "KubernetesProviderExperimentsList",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
