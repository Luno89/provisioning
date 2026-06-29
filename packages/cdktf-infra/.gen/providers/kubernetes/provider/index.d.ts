import { Construct } from 'constructs';
import * as cdktf from 'cdktf';
export interface KubernetesProviderConfig {
    /**
    * PEM-encoded client certificate for TLS authentication.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#client_certificate KubernetesProvider#client_certificate}
    */
    readonly clientCertificate?: string;
    /**
    * PEM-encoded client certificate key for TLS authentication.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#client_key KubernetesProvider#client_key}
    */
    readonly clientKey?: string;
    /**
    * PEM-encoded root certificates bundle for TLS authentication.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#cluster_ca_certificate KubernetesProvider#cluster_ca_certificate}
    */
    readonly clusterCaCertificate?: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#config_context KubernetesProvider#config_context}
    */
    readonly configContext?: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#config_context_auth_info KubernetesProvider#config_context_auth_info}
    */
    readonly configContextAuthInfo?: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#config_context_cluster KubernetesProvider#config_context_cluster}
    */
    readonly configContextCluster?: string;
    /**
    * Path to the kube config file. Can be set with KUBE_CONFIG_PATH.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#config_path KubernetesProvider#config_path}
    */
    readonly configPath?: string;
    /**
    * A list of paths to kube config files. Can be set with KUBE_CONFIG_PATHS environment variable.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#config_paths KubernetesProvider#config_paths}
    */
    readonly configPaths?: string[];
    /**
    * The hostname (in form of URI) of Kubernetes master.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#host KubernetesProvider#host}
    */
    readonly host?: string;
    /**
    * List of Kubernetes metadata annotations to ignore across all resources handled by this provider for situations where external systems are managing certain resource annotations. Each item is a regular expression.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#ignore_annotations KubernetesProvider#ignore_annotations}
    */
    readonly ignoreAnnotations?: string[];
    /**
    * List of Kubernetes metadata labels to ignore across all resources handled by this provider for situations where external systems are managing certain resource labels. Each item is a regular expression.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#ignore_labels KubernetesProvider#ignore_labels}
    */
    readonly ignoreLabels?: string[];
    /**
    * Whether server should be accessed without verifying the TLS certificate.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#insecure KubernetesProvider#insecure}
    */
    readonly insecure?: boolean | cdktf.IResolvable;
    /**
    * The password to use for HTTP basic authentication when accessing the Kubernetes master endpoint.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#password KubernetesProvider#password}
    */
    readonly password?: string;
    /**
    * URL to the proxy to be used for all API requests
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#proxy_url KubernetesProvider#proxy_url}
    */
    readonly proxyUrl?: string;
    /**
    * Server name passed to the server for SNI and is used in the client to check server certificates against.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#tls_server_name KubernetesProvider#tls_server_name}
    */
    readonly tlsServerName?: string;
    /**
    * Token to authenticate an service account
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#token KubernetesProvider#token}
    */
    readonly token?: string;
    /**
    * The username to use for HTTP basic authentication when accessing the Kubernetes master endpoint.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#username KubernetesProvider#username}
    */
    readonly username?: string;
    /**
    * Alias name
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#alias KubernetesProvider#alias}
    */
    readonly alias?: string;
    /**
    * exec block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#exec KubernetesProvider#exec}
    */
    readonly exec?: KubernetesProviderExec[] | cdktf.IResolvable;
    /**
    * experiments block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#experiments KubernetesProvider#experiments}
    */
    readonly experiments?: KubernetesProviderExperiments[] | cdktf.IResolvable;
}
export interface KubernetesProviderExec {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#api_version KubernetesProvider#api_version}
    */
    readonly apiVersion: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#args KubernetesProvider#args}
    */
    readonly args?: string[];
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#command KubernetesProvider#command}
    */
    readonly command: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#env KubernetesProvider#env}
    */
    readonly env?: {
        [key: string]: string;
    };
}
export declare function kubernetesProviderExecToTerraform(struct?: KubernetesProviderExec | cdktf.IResolvable): any;
export declare function kubernetesProviderExecToHclTerraform(struct?: KubernetesProviderExec | cdktf.IResolvable): any;
export interface KubernetesProviderExperiments {
    /**
    * Enable the `kubernetes_manifest` resource.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#manifest_resource KubernetesProvider#manifest_resource}
    */
    readonly manifestResource?: boolean | cdktf.IResolvable;
}
export declare function kubernetesProviderExperimentsToTerraform(struct?: KubernetesProviderExperiments | cdktf.IResolvable): any;
export declare function kubernetesProviderExperimentsToHclTerraform(struct?: KubernetesProviderExperiments | cdktf.IResolvable): any;
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs kubernetes}
*/
export declare class KubernetesProvider extends cdktf.TerraformProvider {
    static readonly tfResourceType = "kubernetes";
    /**
    * Generates CDKTF code for importing a KubernetesProvider resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the KubernetesProvider to import
    * @param importFromId The id of the existing KubernetesProvider that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the KubernetesProvider to import is found
    */
    static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktf.TerraformProvider): cdktf.ImportableResource;
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs kubernetes} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options KubernetesProviderConfig = {}
    */
    constructor(scope: Construct, id: string, config?: KubernetesProviderConfig);
    private _clientCertificate?;
    get clientCertificate(): string | undefined;
    set clientCertificate(value: string | undefined);
    resetClientCertificate(): void;
    get clientCertificateInput(): string | undefined;
    private _clientKey?;
    get clientKey(): string | undefined;
    set clientKey(value: string | undefined);
    resetClientKey(): void;
    get clientKeyInput(): string | undefined;
    private _clusterCaCertificate?;
    get clusterCaCertificate(): string | undefined;
    set clusterCaCertificate(value: string | undefined);
    resetClusterCaCertificate(): void;
    get clusterCaCertificateInput(): string | undefined;
    private _configContext?;
    get configContext(): string | undefined;
    set configContext(value: string | undefined);
    resetConfigContext(): void;
    get configContextInput(): string | undefined;
    private _configContextAuthInfo?;
    get configContextAuthInfo(): string | undefined;
    set configContextAuthInfo(value: string | undefined);
    resetConfigContextAuthInfo(): void;
    get configContextAuthInfoInput(): string | undefined;
    private _configContextCluster?;
    get configContextCluster(): string | undefined;
    set configContextCluster(value: string | undefined);
    resetConfigContextCluster(): void;
    get configContextClusterInput(): string | undefined;
    private _configPath?;
    get configPath(): string | undefined;
    set configPath(value: string | undefined);
    resetConfigPath(): void;
    get configPathInput(): string | undefined;
    private _configPaths?;
    get configPaths(): string[] | undefined;
    set configPaths(value: string[] | undefined);
    resetConfigPaths(): void;
    get configPathsInput(): string[] | undefined;
    private _host?;
    get host(): string | undefined;
    set host(value: string | undefined);
    resetHost(): void;
    get hostInput(): string | undefined;
    private _ignoreAnnotations?;
    get ignoreAnnotations(): string[] | undefined;
    set ignoreAnnotations(value: string[] | undefined);
    resetIgnoreAnnotations(): void;
    get ignoreAnnotationsInput(): string[] | undefined;
    private _ignoreLabels?;
    get ignoreLabels(): string[] | undefined;
    set ignoreLabels(value: string[] | undefined);
    resetIgnoreLabels(): void;
    get ignoreLabelsInput(): string[] | undefined;
    private _insecure?;
    get insecure(): boolean | cdktf.IResolvable | undefined;
    set insecure(value: boolean | cdktf.IResolvable | undefined);
    resetInsecure(): void;
    get insecureInput(): boolean | cdktf.IResolvable | undefined;
    private _password?;
    get password(): string | undefined;
    set password(value: string | undefined);
    resetPassword(): void;
    get passwordInput(): string | undefined;
    private _proxyUrl?;
    get proxyUrl(): string | undefined;
    set proxyUrl(value: string | undefined);
    resetProxyUrl(): void;
    get proxyUrlInput(): string | undefined;
    private _tlsServerName?;
    get tlsServerName(): string | undefined;
    set tlsServerName(value: string | undefined);
    resetTlsServerName(): void;
    get tlsServerNameInput(): string | undefined;
    private _token?;
    get token(): string | undefined;
    set token(value: string | undefined);
    resetToken(): void;
    get tokenInput(): string | undefined;
    private _username?;
    get username(): string | undefined;
    set username(value: string | undefined);
    resetUsername(): void;
    get usernameInput(): string | undefined;
    private _alias?;
    get alias(): string | undefined;
    set alias(value: string | undefined);
    resetAlias(): void;
    get aliasInput(): string | undefined;
    private _exec?;
    get exec(): KubernetesProviderExec[] | cdktf.IResolvable | undefined;
    set exec(value: KubernetesProviderExec[] | cdktf.IResolvable | undefined);
    resetExec(): void;
    get execInput(): cdktf.IResolvable | KubernetesProviderExec[] | undefined;
    private _experiments?;
    get experiments(): KubernetesProviderExperiments[] | cdktf.IResolvable | undefined;
    set experiments(value: KubernetesProviderExperiments[] | cdktf.IResolvable | undefined);
    resetExperiments(): void;
    get experimentsInput(): cdktf.IResolvable | KubernetesProviderExperiments[] | undefined;
    protected synthesizeAttributes(): {
        [name: string]: any;
    };
    protected synthesizeHclAttributes(): {
        [name: string]: any;
    };
}
//# sourceMappingURL=index.d.ts.map