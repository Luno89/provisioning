import { Construct } from 'constructs';
import * as cdktf from 'cdktf';
export interface ServiceConfig extends cdktf.TerraformMetaArguments {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#id Service#id}
    *
    * Please be aware that the id field is automatically added to all resources in Terraform providers using a Terraform provider SDK version below 2.
    * If you experience problems setting this value it might not be settable. Please take a look at the provider documentation to ensure it should be settable.
    */
    readonly id?: string;
    /**
    * Terraform will wait for the load balancer to have at least 1 endpoint before considering the resource created.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#wait_for_load_balancer Service#wait_for_load_balancer}
    */
    readonly waitForLoadBalancer?: boolean | cdktf.IResolvable;
    /**
    * metadata block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#metadata Service#metadata}
    */
    readonly metadata: ServiceMetadata;
    /**
    * spec block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#spec Service#spec}
    */
    readonly spec: ServiceSpec;
    /**
    * timeouts block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#timeouts Service#timeouts}
    */
    readonly timeouts?: ServiceTimeouts;
}
export interface ServiceStatusLoadBalancerIngress {
}
export declare function serviceStatusLoadBalancerIngressToTerraform(struct?: ServiceStatusLoadBalancerIngress): any;
export declare function serviceStatusLoadBalancerIngressToHclTerraform(struct?: ServiceStatusLoadBalancerIngress): any;
export declare class ServiceStatusLoadBalancerIngressOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, complexObjectIndex: number, complexObjectIsFromSet: boolean);
    get internalValue(): ServiceStatusLoadBalancerIngress | undefined;
    set internalValue(value: ServiceStatusLoadBalancerIngress | undefined);
    get hostname(): string;
    get ip(): string;
}
export declare class ServiceStatusLoadBalancerIngressList extends cdktf.ComplexList {
    protected terraformResource: cdktf.IInterpolatingParent;
    protected terraformAttribute: string;
    protected wrapsSet: boolean;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, wrapsSet: boolean);
    /**
    * @param index the index of the item to return
    */
    get(index: number): ServiceStatusLoadBalancerIngressOutputReference;
}
export interface ServiceStatusLoadBalancer {
}
export declare function serviceStatusLoadBalancerToTerraform(struct?: ServiceStatusLoadBalancer): any;
export declare function serviceStatusLoadBalancerToHclTerraform(struct?: ServiceStatusLoadBalancer): any;
export declare class ServiceStatusLoadBalancerOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, complexObjectIndex: number, complexObjectIsFromSet: boolean);
    get internalValue(): ServiceStatusLoadBalancer | undefined;
    set internalValue(value: ServiceStatusLoadBalancer | undefined);
    private _ingress;
    get ingress(): ServiceStatusLoadBalancerIngressList;
}
export declare class ServiceStatusLoadBalancerList extends cdktf.ComplexList {
    protected terraformResource: cdktf.IInterpolatingParent;
    protected terraformAttribute: string;
    protected wrapsSet: boolean;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, wrapsSet: boolean);
    /**
    * @param index the index of the item to return
    */
    get(index: number): ServiceStatusLoadBalancerOutputReference;
}
export interface ServiceStatus {
}
export declare function serviceStatusToTerraform(struct?: ServiceStatus): any;
export declare function serviceStatusToHclTerraform(struct?: ServiceStatus): any;
export declare class ServiceStatusOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, complexObjectIndex: number, complexObjectIsFromSet: boolean);
    get internalValue(): ServiceStatus | undefined;
    set internalValue(value: ServiceStatus | undefined);
    private _loadBalancer;
    get loadBalancer(): ServiceStatusLoadBalancerList;
}
export declare class ServiceStatusList extends cdktf.ComplexList {
    protected terraformResource: cdktf.IInterpolatingParent;
    protected terraformAttribute: string;
    protected wrapsSet: boolean;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, wrapsSet: boolean);
    /**
    * @param index the index of the item to return
    */
    get(index: number): ServiceStatusOutputReference;
}
export interface ServiceMetadata {
    /**
    * An unstructured key value map stored with the service that may be used to store arbitrary metadata. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#annotations Service#annotations}
    */
    readonly annotations?: {
        [key: string]: string;
    };
    /**
    * Prefix, used by the server, to generate a unique name ONLY IF the `name` field has not been provided. This value will also be combined with a unique suffix. More info: https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#idempotency
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#generate_name Service#generate_name}
    */
    readonly generateName?: string;
    /**
    * Map of string keys and values that can be used to organize and categorize (scope and select) the service. May match selectors of replication controllers and services. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#labels Service#labels}
    */
    readonly labels?: {
        [key: string]: string;
    };
    /**
    * Name of the service, must be unique. Cannot be updated. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#names
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#name Service#name}
    */
    readonly name?: string;
    /**
    * Namespace defines the space within which name of the service must be unique.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#namespace Service#namespace}
    */
    readonly namespace?: string;
}
export declare function serviceMetadataToTerraform(struct?: ServiceMetadataOutputReference | ServiceMetadata): any;
export declare function serviceMetadataToHclTerraform(struct?: ServiceMetadataOutputReference | ServiceMetadata): any;
export declare class ServiceMetadataOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): ServiceMetadata | undefined;
    set internalValue(value: ServiceMetadata | undefined);
    private _annotations?;
    get annotations(): {
        [key: string]: string;
    };
    set annotations(value: {
        [key: string]: string;
    });
    resetAnnotations(): void;
    get annotationsInput(): {
        [key: string]: string;
    } | undefined;
    private _generateName?;
    get generateName(): string;
    set generateName(value: string);
    resetGenerateName(): void;
    get generateNameInput(): string | undefined;
    get generation(): number;
    private _labels?;
    get labels(): {
        [key: string]: string;
    };
    set labels(value: {
        [key: string]: string;
    });
    resetLabels(): void;
    get labelsInput(): {
        [key: string]: string;
    } | undefined;
    private _name?;
    get name(): string;
    set name(value: string);
    resetName(): void;
    get nameInput(): string | undefined;
    private _namespace?;
    get namespace(): string;
    set namespace(value: string);
    resetNamespace(): void;
    get namespaceInput(): string | undefined;
    get resourceVersion(): string;
    get uid(): string;
}
export interface ServiceSpecPort {
    /**
    * The application protocol for this port. This field follows standard Kubernetes label syntax. Un-prefixed names are reserved for IANA standard service names (as per RFC-6335 and http://www.iana.org/assignments/service-names). Non-standard protocols should use prefixed names such as mycompany.com/my-custom-protocol.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#app_protocol Service#app_protocol}
    */
    readonly appProtocol?: string;
    /**
    * The name of this port within the service. All ports within the service must have unique names. Optional if only one ServicePort is defined on this service.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#name Service#name}
    */
    readonly name?: string;
    /**
    * The port on each node on which this service is exposed when `type` is `NodePort` or `LoadBalancer`. Usually assigned by the system. If specified, it will be allocated to the service if unused or else creation of the service will fail. Default is to auto-allocate a port if the `type` of this service requires one. More info: https://kubernetes.io/docs/concepts/services-networking/service/#type-nodeport
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#node_port Service#node_port}
    */
    readonly nodePort?: number;
    /**
    * The port that will be exposed by this service.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#port Service#port}
    */
    readonly port: number;
    /**
    * The IP protocol for this port. Supports `TCP` and `UDP`. Default is `TCP`.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#protocol Service#protocol}
    */
    readonly protocol?: string;
    /**
    * Number or name of the port to access on the pods targeted by the service. Number must be in the range 1 to 65535. This field is ignored for services with `cluster_ip = "None"`. More info: https://kubernetes.io/docs/concepts/services-networking/service/#defining-a-service
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#target_port Service#target_port}
    */
    readonly targetPort?: string;
}
export declare function serviceSpecPortToTerraform(struct?: ServiceSpecPort | cdktf.IResolvable): any;
export declare function serviceSpecPortToHclTerraform(struct?: ServiceSpecPort | cdktf.IResolvable): any;
export declare class ServiceSpecPortOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    private resolvableValue?;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, complexObjectIndex: number, complexObjectIsFromSet: boolean);
    get internalValue(): ServiceSpecPort | cdktf.IResolvable | undefined;
    set internalValue(value: ServiceSpecPort | cdktf.IResolvable | undefined);
    private _appProtocol?;
    get appProtocol(): string;
    set appProtocol(value: string);
    resetAppProtocol(): void;
    get appProtocolInput(): string | undefined;
    private _name?;
    get name(): string;
    set name(value: string);
    resetName(): void;
    get nameInput(): string | undefined;
    private _nodePort?;
    get nodePort(): number;
    set nodePort(value: number);
    resetNodePort(): void;
    get nodePortInput(): number | undefined;
    private _port?;
    get port(): number;
    set port(value: number);
    get portInput(): number | undefined;
    private _protocol?;
    get protocol(): string;
    set protocol(value: string);
    resetProtocol(): void;
    get protocolInput(): string | undefined;
    private _targetPort?;
    get targetPort(): string;
    set targetPort(value: string);
    resetTargetPort(): void;
    get targetPortInput(): string | undefined;
}
export declare class ServiceSpecPortList extends cdktf.ComplexList {
    protected terraformResource: cdktf.IInterpolatingParent;
    protected terraformAttribute: string;
    protected wrapsSet: boolean;
    internalValue?: ServiceSpecPort[] | cdktf.IResolvable;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, wrapsSet: boolean);
    /**
    * @param index the index of the item to return
    */
    get(index: number): ServiceSpecPortOutputReference;
}
export interface ServiceSpecSessionAffinityConfigClientIp {
    /**
    * Specifies the seconds of `ClientIP` type session sticky time. The value must be > 0 and <= 86400(for 1 day) if `ServiceAffinity` == `ClientIP`.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#timeout_seconds Service#timeout_seconds}
    */
    readonly timeoutSeconds?: number;
}
export declare function serviceSpecSessionAffinityConfigClientIpToTerraform(struct?: ServiceSpecSessionAffinityConfigClientIpOutputReference | ServiceSpecSessionAffinityConfigClientIp): any;
export declare function serviceSpecSessionAffinityConfigClientIpToHclTerraform(struct?: ServiceSpecSessionAffinityConfigClientIpOutputReference | ServiceSpecSessionAffinityConfigClientIp): any;
export declare class ServiceSpecSessionAffinityConfigClientIpOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): ServiceSpecSessionAffinityConfigClientIp | undefined;
    set internalValue(value: ServiceSpecSessionAffinityConfigClientIp | undefined);
    private _timeoutSeconds?;
    get timeoutSeconds(): number;
    set timeoutSeconds(value: number);
    resetTimeoutSeconds(): void;
    get timeoutSecondsInput(): number | undefined;
}
export interface ServiceSpecSessionAffinityConfig {
    /**
    * client_ip block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#client_ip Service#client_ip}
    */
    readonly clientIp?: ServiceSpecSessionAffinityConfigClientIp;
}
export declare function serviceSpecSessionAffinityConfigToTerraform(struct?: ServiceSpecSessionAffinityConfigOutputReference | ServiceSpecSessionAffinityConfig): any;
export declare function serviceSpecSessionAffinityConfigToHclTerraform(struct?: ServiceSpecSessionAffinityConfigOutputReference | ServiceSpecSessionAffinityConfig): any;
export declare class ServiceSpecSessionAffinityConfigOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): ServiceSpecSessionAffinityConfig | undefined;
    set internalValue(value: ServiceSpecSessionAffinityConfig | undefined);
    private _clientIp;
    get clientIp(): ServiceSpecSessionAffinityConfigClientIpOutputReference;
    putClientIp(value: ServiceSpecSessionAffinityConfigClientIp): void;
    resetClientIp(): void;
    get clientIpInput(): ServiceSpecSessionAffinityConfigClientIp | undefined;
}
export interface ServiceSpec {
    /**
    * Defines if `NodePorts` will be automatically allocated for services with type `LoadBalancer`. It may be set to `false` if the cluster load-balancer does not rely on `NodePorts`.  If the caller requests specific `NodePorts` (by specifying a value), those requests will be respected, regardless of this field. This field may only be set for services with type `LoadBalancer`. Default is `true`. More info: https://kubernetes.io/docs/concepts/services-networking/service/#load-balancer-nodeport-allocation
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#allocate_load_balancer_node_ports Service#allocate_load_balancer_node_ports}
    */
    readonly allocateLoadBalancerNodePorts?: boolean | cdktf.IResolvable;
    /**
    * The IP address of the service. It is usually assigned randomly by the master. If an address is specified manually and is not in use by others, it will be allocated to the service; otherwise, creation of the service will fail. `None` can be specified for headless services when proxying is not required. Ignored if type is `ExternalName`. More info: https://kubernetes.io/docs/concepts/services-networking/service/#virtual-ips-and-service-proxies
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#cluster_ip Service#cluster_ip}
    */
    readonly clusterIp?: string;
    /**
    * List of IP addresses assigned to this service, and are usually assigned randomly. If an address is specified manually and is not in use by others, it will be allocated to the service; otherwise creation of the service will fail. If this field is not specified, it will be initialized from the `clusterIP` field. If this field is specified, clients must ensure that `clusterIPs[0]` and `clusterIP` have the same value. More info: https://kubernetes.io/docs/concepts/services-networking/service/#virtual-ips-and-service-proxies
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#cluster_ips Service#cluster_ips}
    */
    readonly clusterIps?: string[];
    /**
    * A list of IP addresses for which nodes in the cluster will also accept traffic for this service. These IPs are not managed by Kubernetes. The user is responsible for ensuring that traffic arrives at a node with this IP.  A common example is external load-balancers that are not part of the Kubernetes system.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#external_ips Service#external_ips}
    */
    readonly externalIps?: string[];
    /**
    * The external reference that kubedns or equivalent will return as a CNAME record for this service. No proxying will be involved. Must be a valid DNS name and requires `type` to be `ExternalName`.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#external_name Service#external_name}
    */
    readonly externalName?: string;
    /**
    * Denotes if this Service desires to route external traffic to node-local or cluster-wide endpoints. `Local` preserves the client source IP and avoids a second hop for LoadBalancer and Nodeport type services, but risks potentially imbalanced traffic spreading. `Cluster` obscures the client source IP and may cause a second hop to another node, but should have good overall load-spreading. More info: https://kubernetes.io/docs/tutorials/services/source-ip/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#external_traffic_policy Service#external_traffic_policy}
    */
    readonly externalTrafficPolicy?: string;
    /**
    * Specifies the Healthcheck NodePort for the service. Only effects when type is set to `LoadBalancer` and external_traffic_policy is set to `Local`.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#health_check_node_port Service#health_check_node_port}
    */
    readonly healthCheckNodePort?: number;
    /**
    * Specifies if the cluster internal traffic should be routed to all endpoints or node-local endpoints only. `Cluster` routes internal traffic to a Service to all endpoints. `Local` routes traffic to node-local endpoints only, traffic is dropped if no node-local endpoints are ready. The default value is `Cluster`.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#internal_traffic_policy Service#internal_traffic_policy}
    */
    readonly internalTrafficPolicy?: string;
    /**
    * IPFamilies is a list of IP families (e.g. IPv4, IPv6) assigned to this service. This field is usually assigned automatically based on cluster configuration and the ipFamilyPolicy field. If this field is specified manually, the requested family is available in the cluster, and ipFamilyPolicy allows it, it will be used; otherwise creation of the service will fail. This field is conditionally mutable: it allows for adding or removing a secondary IP family, but it does not allow changing the primary IP family of the Service.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#ip_families Service#ip_families}
    */
    readonly ipFamilies?: string[];
    /**
    * IPFamilyPolicy represents the dual-stack-ness requested or required by this Service. If there is no value provided, then this field will be set to SingleStack. Services can be 'SingleStack' (a single IP family), 'PreferDualStack' (two IP families on dual-stack configured clusters or a single IP family on single-stack clusters), or 'RequireDualStack' (two IP families on dual-stack configured clusters, otherwise fail). The ipFamilies and clusterIPs fields depend on the value of this field.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#ip_family_policy Service#ip_family_policy}
    */
    readonly ipFamilyPolicy?: string;
    /**
    * The class of the load balancer implementation this Service belongs to. If specified, the value of this field must be a label-style identifier, with an optional prefix. This field can only be set when the Service type is `LoadBalancer`. If not set, the default load balancer implementation is used. This field can only be set when creating or updating a Service to type `LoadBalancer`. More info: https://kubernetes.io/docs/concepts/services-networking/service/#load-balancer-class
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#load_balancer_class Service#load_balancer_class}
    */
    readonly loadBalancerClass?: string;
    /**
    * Only applies to `type = LoadBalancer`. LoadBalancer will get created with the IP specified in this field. This feature depends on whether the underlying cloud-provider supports specifying this field when a load balancer is created. This field will be ignored if the cloud-provider does not support the feature.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#load_balancer_ip Service#load_balancer_ip}
    */
    readonly loadBalancerIp?: string;
    /**
    * If specified and supported by the platform, this will restrict traffic through the cloud-provider load-balancer will be restricted to the specified client IPs. This field will be ignored if the cloud-provider does not support the feature. More info: http://kubernetes.io/docs/user-guide/services-firewalls
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#load_balancer_source_ranges Service#load_balancer_source_ranges}
    */
    readonly loadBalancerSourceRanges?: string[];
    /**
    * When set to true, indicates that DNS implementations must publish the `notReadyAddresses` of subsets for the Endpoints associated with the Service. The default value is `false`. The primary use case for setting this field is to use a StatefulSet's Headless Service to propagate `SRV` records for its Pods without respect to their readiness for purpose of peer discovery.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#publish_not_ready_addresses Service#publish_not_ready_addresses}
    */
    readonly publishNotReadyAddresses?: boolean | cdktf.IResolvable;
    /**
    * Route service traffic to pods with label keys and values matching this selector. Only applies to types `ClusterIP`, `NodePort`, and `LoadBalancer`. More info: https://kubernetes.io/docs/concepts/services-networking/service/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#selector Service#selector}
    */
    readonly selector?: {
        [key: string]: string;
    };
    /**
    * Used to maintain session affinity. Supports `ClientIP` and `None`. Defaults to `None`. More info: https://kubernetes.io/docs/concepts/services-networking/service/#virtual-ips-and-service-proxies
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#session_affinity Service#session_affinity}
    */
    readonly sessionAffinity?: string;
    /**
    * Determines how the service is exposed. Defaults to `ClusterIP`. Valid options are `ExternalName`, `ClusterIP`, `NodePort`, and `LoadBalancer`. `ExternalName` maps to the specified `external_name`. More info: https://kubernetes.io/docs/concepts/services-networking/service/#publishing-services-service-types
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#type Service#type}
    */
    readonly type?: string;
    /**
    * port block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#port Service#port}
    */
    readonly port?: ServiceSpecPort[] | cdktf.IResolvable;
    /**
    * session_affinity_config block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#session_affinity_config Service#session_affinity_config}
    */
    readonly sessionAffinityConfig?: ServiceSpecSessionAffinityConfig;
}
export declare function serviceSpecToTerraform(struct?: ServiceSpecOutputReference | ServiceSpec): any;
export declare function serviceSpecToHclTerraform(struct?: ServiceSpecOutputReference | ServiceSpec): any;
export declare class ServiceSpecOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): ServiceSpec | undefined;
    set internalValue(value: ServiceSpec | undefined);
    private _allocateLoadBalancerNodePorts?;
    get allocateLoadBalancerNodePorts(): boolean | cdktf.IResolvable;
    set allocateLoadBalancerNodePorts(value: boolean | cdktf.IResolvable);
    resetAllocateLoadBalancerNodePorts(): void;
    get allocateLoadBalancerNodePortsInput(): boolean | cdktf.IResolvable | undefined;
    private _clusterIp?;
    get clusterIp(): string;
    set clusterIp(value: string);
    resetClusterIp(): void;
    get clusterIpInput(): string | undefined;
    private _clusterIps?;
    get clusterIps(): string[];
    set clusterIps(value: string[]);
    resetClusterIps(): void;
    get clusterIpsInput(): string[] | undefined;
    private _externalIps?;
    get externalIps(): string[];
    set externalIps(value: string[]);
    resetExternalIps(): void;
    get externalIpsInput(): string[] | undefined;
    private _externalName?;
    get externalName(): string;
    set externalName(value: string);
    resetExternalName(): void;
    get externalNameInput(): string | undefined;
    private _externalTrafficPolicy?;
    get externalTrafficPolicy(): string;
    set externalTrafficPolicy(value: string);
    resetExternalTrafficPolicy(): void;
    get externalTrafficPolicyInput(): string | undefined;
    private _healthCheckNodePort?;
    get healthCheckNodePort(): number;
    set healthCheckNodePort(value: number);
    resetHealthCheckNodePort(): void;
    get healthCheckNodePortInput(): number | undefined;
    private _internalTrafficPolicy?;
    get internalTrafficPolicy(): string;
    set internalTrafficPolicy(value: string);
    resetInternalTrafficPolicy(): void;
    get internalTrafficPolicyInput(): string | undefined;
    private _ipFamilies?;
    get ipFamilies(): string[];
    set ipFamilies(value: string[]);
    resetIpFamilies(): void;
    get ipFamiliesInput(): string[] | undefined;
    private _ipFamilyPolicy?;
    get ipFamilyPolicy(): string;
    set ipFamilyPolicy(value: string);
    resetIpFamilyPolicy(): void;
    get ipFamilyPolicyInput(): string | undefined;
    private _loadBalancerClass?;
    get loadBalancerClass(): string;
    set loadBalancerClass(value: string);
    resetLoadBalancerClass(): void;
    get loadBalancerClassInput(): string | undefined;
    private _loadBalancerIp?;
    get loadBalancerIp(): string;
    set loadBalancerIp(value: string);
    resetLoadBalancerIp(): void;
    get loadBalancerIpInput(): string | undefined;
    private _loadBalancerSourceRanges?;
    get loadBalancerSourceRanges(): string[];
    set loadBalancerSourceRanges(value: string[]);
    resetLoadBalancerSourceRanges(): void;
    get loadBalancerSourceRangesInput(): string[] | undefined;
    private _publishNotReadyAddresses?;
    get publishNotReadyAddresses(): boolean | cdktf.IResolvable;
    set publishNotReadyAddresses(value: boolean | cdktf.IResolvable);
    resetPublishNotReadyAddresses(): void;
    get publishNotReadyAddressesInput(): boolean | cdktf.IResolvable | undefined;
    private _selector?;
    get selector(): {
        [key: string]: string;
    };
    set selector(value: {
        [key: string]: string;
    });
    resetSelector(): void;
    get selectorInput(): {
        [key: string]: string;
    } | undefined;
    private _sessionAffinity?;
    get sessionAffinity(): string;
    set sessionAffinity(value: string);
    resetSessionAffinity(): void;
    get sessionAffinityInput(): string | undefined;
    private _type?;
    get type(): string;
    set type(value: string);
    resetType(): void;
    get typeInput(): string | undefined;
    private _port;
    get port(): ServiceSpecPortList;
    putPort(value: ServiceSpecPort[] | cdktf.IResolvable): void;
    resetPort(): void;
    get portInput(): cdktf.IResolvable | ServiceSpecPort[] | undefined;
    private _sessionAffinityConfig;
    get sessionAffinityConfig(): ServiceSpecSessionAffinityConfigOutputReference;
    putSessionAffinityConfig(value: ServiceSpecSessionAffinityConfig): void;
    resetSessionAffinityConfig(): void;
    get sessionAffinityConfigInput(): ServiceSpecSessionAffinityConfig | undefined;
}
export interface ServiceTimeouts {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#create Service#create}
    */
    readonly create?: string;
}
export declare function serviceTimeoutsToTerraform(struct?: ServiceTimeouts | cdktf.IResolvable): any;
export declare function serviceTimeoutsToHclTerraform(struct?: ServiceTimeouts | cdktf.IResolvable): any;
export declare class ServiceTimeoutsOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    private resolvableValue?;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): ServiceTimeouts | cdktf.IResolvable | undefined;
    set internalValue(value: ServiceTimeouts | cdktf.IResolvable | undefined);
    private _create?;
    get create(): string;
    set create(value: string);
    resetCreate(): void;
    get createInput(): string | undefined;
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service kubernetes_service}
*/
export declare class Service extends cdktf.TerraformResource {
    static readonly tfResourceType = "kubernetes_service";
    /**
    * Generates CDKTF code for importing a Service resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Service to import
    * @param importFromId The id of the existing Service that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Service to import is found
    */
    static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktf.TerraformProvider): cdktf.ImportableResource;
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service kubernetes_service} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options ServiceConfig
    */
    constructor(scope: Construct, id: string, config: ServiceConfig);
    private _id?;
    get id(): string;
    set id(value: string);
    resetId(): void;
    get idInput(): string | undefined;
    private _status;
    get status(): ServiceStatusList;
    private _waitForLoadBalancer?;
    get waitForLoadBalancer(): boolean | cdktf.IResolvable;
    set waitForLoadBalancer(value: boolean | cdktf.IResolvable);
    resetWaitForLoadBalancer(): void;
    get waitForLoadBalancerInput(): boolean | cdktf.IResolvable | undefined;
    private _metadata;
    get metadata(): ServiceMetadataOutputReference;
    putMetadata(value: ServiceMetadata): void;
    get metadataInput(): ServiceMetadata | undefined;
    private _spec;
    get spec(): ServiceSpecOutputReference;
    putSpec(value: ServiceSpec): void;
    get specInput(): ServiceSpec | undefined;
    private _timeouts;
    get timeouts(): ServiceTimeoutsOutputReference;
    putTimeouts(value: ServiceTimeouts): void;
    resetTimeouts(): void;
    get timeoutsInput(): cdktf.IResolvable | ServiceTimeouts | undefined;
    protected synthesizeAttributes(): {
        [name: string]: any;
    };
    protected synthesizeHclAttributes(): {
        [name: string]: any;
    };
}
//# sourceMappingURL=index.d.ts.map