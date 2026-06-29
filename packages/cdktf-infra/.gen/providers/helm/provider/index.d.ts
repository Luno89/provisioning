import { Construct } from 'constructs';
import * as cdktf from 'cdktf';
export interface HelmProviderConfig {
    /**
    * Helm burst limit. Increase this if you have a cluster with many CRDs
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#burst_limit HelmProvider#burst_limit}
    */
    readonly burstLimit?: number;
    /**
    * Debug indicates whether or not Helm is running in Debug mode.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#debug HelmProvider#debug}
    */
    readonly debug?: boolean | cdktf.IResolvable;
    /**
    * The backend storage driver. Values are: configmap, secret, memory, sql
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#helm_driver HelmProvider#helm_driver}
    */
    readonly helmDriver?: string;
    /**
    * The path to the helm plugins directory
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#plugins_path HelmProvider#plugins_path}
    */
    readonly pluginsPath?: string;
    /**
    * The path to the registry config file
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#registry_config_path HelmProvider#registry_config_path}
    */
    readonly registryConfigPath?: string;
    /**
    * The path to the file containing cached repository indexes
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#repository_cache HelmProvider#repository_cache}
    */
    readonly repositoryCache?: string;
    /**
    * The path to the file containing repository names and URLs
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#repository_config_path HelmProvider#repository_config_path}
    */
    readonly repositoryConfigPath?: string;
    /**
    * Alias name
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#alias HelmProvider#alias}
    */
    readonly alias?: string;
    /**
    * experiments block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#experiments HelmProvider#experiments}
    */
    readonly experiments?: HelmProviderExperiments;
    /**
    * kubernetes block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#kubernetes HelmProvider#kubernetes}
    */
    readonly kubernetes?: HelmProviderKubernetes;
    /**
    * registry block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#registry HelmProvider#registry}
    */
    readonly registry?: HelmProviderRegistry[] | cdktf.IResolvable;
}
export interface HelmProviderExperiments {
    /**
    * Enable full diff by storing the rendered manifest in the state. This has similar limitations as when using helm install --dry-run. See https://helm.sh/docs/chart_best_practices/custom_resource_definitions/#install-a-crd-declaration-before-using-the-resource
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#manifest HelmProvider#manifest}
    */
    readonly manifest?: boolean | cdktf.IResolvable;
}
export declare function helmProviderExperimentsToTerraform(struct?: HelmProviderExperiments): any;
export declare function helmProviderExperimentsToHclTerraform(struct?: HelmProviderExperiments): any;
export interface HelmProviderKubernetesExec {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#api_version HelmProvider#api_version}
    */
    readonly apiVersion: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#args HelmProvider#args}
    */
    readonly args?: string[];
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#command HelmProvider#command}
    */
    readonly command: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#env HelmProvider#env}
    */
    readonly env?: {
        [key: string]: string;
    };
}
export declare function helmProviderKubernetesExecToTerraform(struct?: HelmProviderKubernetesExec): any;
export declare function helmProviderKubernetesExecToHclTerraform(struct?: HelmProviderKubernetesExec): any;
export interface HelmProviderKubernetes {
    /**
    * PEM-encoded client certificate for TLS authentication.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#client_certificate HelmProvider#client_certificate}
    */
    readonly clientCertificate?: string;
    /**
    * PEM-encoded client certificate key for TLS authentication.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#client_key HelmProvider#client_key}
    */
    readonly clientKey?: string;
    /**
    * PEM-encoded root certificates bundle for TLS authentication.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#cluster_ca_certificate HelmProvider#cluster_ca_certificate}
    */
    readonly clusterCaCertificate?: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#config_context HelmProvider#config_context}
    */
    readonly configContext?: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#config_context_auth_info HelmProvider#config_context_auth_info}
    */
    readonly configContextAuthInfo?: string;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#config_context_cluster HelmProvider#config_context_cluster}
    */
    readonly configContextCluster?: string;
    /**
    * Path to the kube config file. Can be set with KUBE_CONFIG_PATH.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#config_path HelmProvider#config_path}
    */
    readonly configPath?: string;
    /**
    * A list of paths to kube config files. Can be set with KUBE_CONFIG_PATHS environment variable.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#config_paths HelmProvider#config_paths}
    */
    readonly configPaths?: string[];
    /**
    * The hostname (in form of URI) of Kubernetes master.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#host HelmProvider#host}
    */
    readonly host?: string;
    /**
    * Whether server should be accessed without verifying the TLS certificate.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#insecure HelmProvider#insecure}
    */
    readonly insecure?: boolean | cdktf.IResolvable;
    /**
    * The password to use for HTTP basic authentication when accessing the Kubernetes master endpoint.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#password HelmProvider#password}
    */
    readonly password?: string;
    /**
    * URL to the proxy to be used for all API requests
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#proxy_url HelmProvider#proxy_url}
    */
    readonly proxyUrl?: string;
    /**
    * Server name passed to the server for SNI and is used in the client to check server certificates against.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#tls_server_name HelmProvider#tls_server_name}
    */
    readonly tlsServerName?: string;
    /**
    * Token to authenticate an service account
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#token HelmProvider#token}
    */
    readonly token?: string;
    /**
    * The username to use for HTTP basic authentication when accessing the Kubernetes master endpoint.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#username HelmProvider#username}
    */
    readonly username?: string;
    /**
    * exec block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#exec HelmProvider#exec}
    */
    readonly exec?: HelmProviderKubernetesExec;
}
export declare function helmProviderKubernetesToTerraform(struct?: HelmProviderKubernetes): any;
export declare function helmProviderKubernetesToHclTerraform(struct?: HelmProviderKubernetes): any;
export interface HelmProviderRegistry {
    /**
    * The password to use for the OCI HTTP basic authentication when accessing the Kubernetes master endpoint.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#password HelmProvider#password}
    */
    readonly password: string;
    /**
    * OCI URL in form of oci://host:port or oci://host
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#url HelmProvider#url}
    */
    readonly url: string;
    /**
    * The username to use for the OCI HTTP basic authentication when accessing the Kubernetes master endpoint.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#username HelmProvider#username}
    */
    readonly username: string;
}
export declare function helmProviderRegistryToTerraform(struct?: HelmProviderRegistry | cdktf.IResolvable): any;
export declare function helmProviderRegistryToHclTerraform(struct?: HelmProviderRegistry | cdktf.IResolvable): any;
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs helm}
*/
export declare class HelmProvider extends cdktf.TerraformProvider {
    static readonly tfResourceType = "helm";
    /**
    * Generates CDKTF code for importing a HelmProvider resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the HelmProvider to import
    * @param importFromId The id of the existing HelmProvider that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the HelmProvider to import is found
    */
    static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktf.TerraformProvider): cdktf.ImportableResource;
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs helm} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options HelmProviderConfig = {}
    */
    constructor(scope: Construct, id: string, config?: HelmProviderConfig);
    private _burstLimit?;
    get burstLimit(): number | undefined;
    set burstLimit(value: number | undefined);
    resetBurstLimit(): void;
    get burstLimitInput(): number | undefined;
    private _debug?;
    get debug(): boolean | cdktf.IResolvable | undefined;
    set debug(value: boolean | cdktf.IResolvable | undefined);
    resetDebug(): void;
    get debugInput(): boolean | cdktf.IResolvable | undefined;
    private _helmDriver?;
    get helmDriver(): string | undefined;
    set helmDriver(value: string | undefined);
    resetHelmDriver(): void;
    get helmDriverInput(): string | undefined;
    private _pluginsPath?;
    get pluginsPath(): string | undefined;
    set pluginsPath(value: string | undefined);
    resetPluginsPath(): void;
    get pluginsPathInput(): string | undefined;
    private _registryConfigPath?;
    get registryConfigPath(): string | undefined;
    set registryConfigPath(value: string | undefined);
    resetRegistryConfigPath(): void;
    get registryConfigPathInput(): string | undefined;
    private _repositoryCache?;
    get repositoryCache(): string | undefined;
    set repositoryCache(value: string | undefined);
    resetRepositoryCache(): void;
    get repositoryCacheInput(): string | undefined;
    private _repositoryConfigPath?;
    get repositoryConfigPath(): string | undefined;
    set repositoryConfigPath(value: string | undefined);
    resetRepositoryConfigPath(): void;
    get repositoryConfigPathInput(): string | undefined;
    private _alias?;
    get alias(): string | undefined;
    set alias(value: string | undefined);
    resetAlias(): void;
    get aliasInput(): string | undefined;
    private _experiments?;
    get experiments(): HelmProviderExperiments | undefined;
    set experiments(value: HelmProviderExperiments | undefined);
    resetExperiments(): void;
    get experimentsInput(): HelmProviderExperiments | undefined;
    private _kubernetes?;
    get kubernetes(): HelmProviderKubernetes | undefined;
    set kubernetes(value: HelmProviderKubernetes | undefined);
    resetKubernetes(): void;
    get kubernetesInput(): HelmProviderKubernetes | undefined;
    private _registry?;
    get registry(): HelmProviderRegistry[] | cdktf.IResolvable | undefined;
    set registry(value: HelmProviderRegistry[] | cdktf.IResolvable | undefined);
    resetRegistry(): void;
    get registryInput(): cdktf.IResolvable | HelmProviderRegistry[] | undefined;
    protected synthesizeAttributes(): {
        [name: string]: any;
    };
    protected synthesizeHclAttributes(): {
        [name: string]: any;
    };
}
//# sourceMappingURL=index.d.ts.map