import { Construct } from 'constructs';
import * as cdktf from 'cdktf';
export interface PersistentVolumeClaimConfig extends cdktf.TerraformMetaArguments {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#id PersistentVolumeClaim#id}
    *
    * Please be aware that the id field is automatically added to all resources in Terraform providers using a Terraform provider SDK version below 2.
    * If you experience problems setting this value it might not be settable. Please take a look at the provider documentation to ensure it should be settable.
    */
    readonly id?: string;
    /**
    * Whether to wait for the claim to reach `Bound` state (to find volume in which to claim the space)
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#wait_until_bound PersistentVolumeClaim#wait_until_bound}
    */
    readonly waitUntilBound?: boolean | cdktf.IResolvable;
    /**
    * metadata block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#metadata PersistentVolumeClaim#metadata}
    */
    readonly metadata: PersistentVolumeClaimMetadata;
    /**
    * spec block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#spec PersistentVolumeClaim#spec}
    */
    readonly spec: PersistentVolumeClaimSpec;
    /**
    * timeouts block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#timeouts PersistentVolumeClaim#timeouts}
    */
    readonly timeouts?: PersistentVolumeClaimTimeouts;
}
export interface PersistentVolumeClaimMetadata {
    /**
    * An unstructured key value map stored with the persistent volume claim that may be used to store arbitrary metadata. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#annotations PersistentVolumeClaim#annotations}
    */
    readonly annotations?: {
        [key: string]: string;
    };
    /**
    * Prefix, used by the server, to generate a unique name ONLY IF the `name` field has not been provided. This value will also be combined with a unique suffix. More info: https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#idempotency
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#generate_name PersistentVolumeClaim#generate_name}
    */
    readonly generateName?: string;
    /**
    * Map of string keys and values that can be used to organize and categorize (scope and select) the persistent volume claim. May match selectors of replication controllers and services. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#labels PersistentVolumeClaim#labels}
    */
    readonly labels?: {
        [key: string]: string;
    };
    /**
    * Name of the persistent volume claim, must be unique. Cannot be updated. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#names
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#name PersistentVolumeClaim#name}
    */
    readonly name?: string;
    /**
    * Namespace defines the space within which name of the persistent volume claim must be unique.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#namespace PersistentVolumeClaim#namespace}
    */
    readonly namespace?: string;
}
export declare function persistentVolumeClaimMetadataToTerraform(struct?: PersistentVolumeClaimMetadataOutputReference | PersistentVolumeClaimMetadata): any;
export declare function persistentVolumeClaimMetadataToHclTerraform(struct?: PersistentVolumeClaimMetadataOutputReference | PersistentVolumeClaimMetadata): any;
export declare class PersistentVolumeClaimMetadataOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): PersistentVolumeClaimMetadata | undefined;
    set internalValue(value: PersistentVolumeClaimMetadata | undefined);
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
export interface PersistentVolumeClaimSpecResources {
    /**
    * Map describing the maximum amount of compute resources allowed. More info: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#limits PersistentVolumeClaim#limits}
    */
    readonly limits?: {
        [key: string]: string;
    };
    /**
    * Map describing the minimum amount of compute resources required. If this is omitted for a container, it defaults to `limits` if that is explicitly specified, otherwise to an implementation-defined value. More info: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#requests PersistentVolumeClaim#requests}
    */
    readonly requests?: {
        [key: string]: string;
    };
}
export declare function persistentVolumeClaimSpecResourcesToTerraform(struct?: PersistentVolumeClaimSpecResourcesOutputReference | PersistentVolumeClaimSpecResources): any;
export declare function persistentVolumeClaimSpecResourcesToHclTerraform(struct?: PersistentVolumeClaimSpecResourcesOutputReference | PersistentVolumeClaimSpecResources): any;
export declare class PersistentVolumeClaimSpecResourcesOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): PersistentVolumeClaimSpecResources | undefined;
    set internalValue(value: PersistentVolumeClaimSpecResources | undefined);
    private _limits?;
    get limits(): {
        [key: string]: string;
    };
    set limits(value: {
        [key: string]: string;
    });
    resetLimits(): void;
    get limitsInput(): {
        [key: string]: string;
    } | undefined;
    private _requests?;
    get requests(): {
        [key: string]: string;
    };
    set requests(value: {
        [key: string]: string;
    });
    resetRequests(): void;
    get requestsInput(): {
        [key: string]: string;
    } | undefined;
}
export interface PersistentVolumeClaimSpecSelectorMatchExpressions {
    /**
    * The label key that the selector applies to.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#key PersistentVolumeClaim#key}
    */
    readonly key?: string;
    /**
    * A key's relationship to a set of values. Valid operators ard `In`, `NotIn`, `Exists` and `DoesNotExist`.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#operator PersistentVolumeClaim#operator}
    */
    readonly operator?: string;
    /**
    * An array of string values. If the operator is `In` or `NotIn`, the values array must be non-empty. If the operator is `Exists` or `DoesNotExist`, the values array must be empty. This array is replaced during a strategic merge patch.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#values PersistentVolumeClaim#values}
    */
    readonly values?: string[];
}
export declare function persistentVolumeClaimSpecSelectorMatchExpressionsToTerraform(struct?: PersistentVolumeClaimSpecSelectorMatchExpressions | cdktf.IResolvable): any;
export declare function persistentVolumeClaimSpecSelectorMatchExpressionsToHclTerraform(struct?: PersistentVolumeClaimSpecSelectorMatchExpressions | cdktf.IResolvable): any;
export declare class PersistentVolumeClaimSpecSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    private resolvableValue?;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, complexObjectIndex: number, complexObjectIsFromSet: boolean);
    get internalValue(): PersistentVolumeClaimSpecSelectorMatchExpressions | cdktf.IResolvable | undefined;
    set internalValue(value: PersistentVolumeClaimSpecSelectorMatchExpressions | cdktf.IResolvable | undefined);
    private _key?;
    get key(): string;
    set key(value: string);
    resetKey(): void;
    get keyInput(): string | undefined;
    private _operator?;
    get operator(): string;
    set operator(value: string);
    resetOperator(): void;
    get operatorInput(): string | undefined;
    private _values?;
    get values(): string[];
    set values(value: string[]);
    resetValues(): void;
    get valuesInput(): string[] | undefined;
}
export declare class PersistentVolumeClaimSpecSelectorMatchExpressionsList extends cdktf.ComplexList {
    protected terraformResource: cdktf.IInterpolatingParent;
    protected terraformAttribute: string;
    protected wrapsSet: boolean;
    internalValue?: PersistentVolumeClaimSpecSelectorMatchExpressions[] | cdktf.IResolvable;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string, wrapsSet: boolean);
    /**
    * @param index the index of the item to return
    */
    get(index: number): PersistentVolumeClaimSpecSelectorMatchExpressionsOutputReference;
}
export interface PersistentVolumeClaimSpecSelector {
    /**
    * A map of {key,value} pairs. A single {key,value} in the matchLabels map is equivalent to an element of `match_expressions`, whose key field is "key", the operator is "In", and the values array contains only "value". The requirements are ANDed.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#match_labels PersistentVolumeClaim#match_labels}
    */
    readonly matchLabels?: {
        [key: string]: string;
    };
    /**
    * match_expressions block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#match_expressions PersistentVolumeClaim#match_expressions}
    */
    readonly matchExpressions?: PersistentVolumeClaimSpecSelectorMatchExpressions[] | cdktf.IResolvable;
}
export declare function persistentVolumeClaimSpecSelectorToTerraform(struct?: PersistentVolumeClaimSpecSelectorOutputReference | PersistentVolumeClaimSpecSelector): any;
export declare function persistentVolumeClaimSpecSelectorToHclTerraform(struct?: PersistentVolumeClaimSpecSelectorOutputReference | PersistentVolumeClaimSpecSelector): any;
export declare class PersistentVolumeClaimSpecSelectorOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): PersistentVolumeClaimSpecSelector | undefined;
    set internalValue(value: PersistentVolumeClaimSpecSelector | undefined);
    private _matchLabels?;
    get matchLabels(): {
        [key: string]: string;
    };
    set matchLabels(value: {
        [key: string]: string;
    });
    resetMatchLabels(): void;
    get matchLabelsInput(): {
        [key: string]: string;
    } | undefined;
    private _matchExpressions;
    get matchExpressions(): PersistentVolumeClaimSpecSelectorMatchExpressionsList;
    putMatchExpressions(value: PersistentVolumeClaimSpecSelectorMatchExpressions[] | cdktf.IResolvable): void;
    resetMatchExpressions(): void;
    get matchExpressionsInput(): cdktf.IResolvable | PersistentVolumeClaimSpecSelectorMatchExpressions[] | undefined;
}
export interface PersistentVolumeClaimSpec {
    /**
    * A set of the desired access modes the volume should have. More info: https://kubernetes.io/docs/concepts/storage/persistent-volumes#access-modes
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#access_modes PersistentVolumeClaim#access_modes}
    */
    readonly accessModes: string[];
    /**
    * Name of the storage class requested by the claim
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#storage_class_name PersistentVolumeClaim#storage_class_name}
    */
    readonly storageClassName?: string;
    /**
    * Defines what type of volume is required by the claim.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#volume_mode PersistentVolumeClaim#volume_mode}
    */
    readonly volumeMode?: string;
    /**
    * The binding reference to the PersistentVolume backing this claim.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#volume_name PersistentVolumeClaim#volume_name}
    */
    readonly volumeName?: string;
    /**
    * resources block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#resources PersistentVolumeClaim#resources}
    */
    readonly resources: PersistentVolumeClaimSpecResources;
    /**
    * selector block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#selector PersistentVolumeClaim#selector}
    */
    readonly selector?: PersistentVolumeClaimSpecSelector;
}
export declare function persistentVolumeClaimSpecToTerraform(struct?: PersistentVolumeClaimSpecOutputReference | PersistentVolumeClaimSpec): any;
export declare function persistentVolumeClaimSpecToHclTerraform(struct?: PersistentVolumeClaimSpecOutputReference | PersistentVolumeClaimSpec): any;
export declare class PersistentVolumeClaimSpecOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): PersistentVolumeClaimSpec | undefined;
    set internalValue(value: PersistentVolumeClaimSpec | undefined);
    private _accessModes?;
    get accessModes(): string[];
    set accessModes(value: string[]);
    get accessModesInput(): string[] | undefined;
    private _storageClassName?;
    get storageClassName(): string;
    set storageClassName(value: string);
    resetStorageClassName(): void;
    get storageClassNameInput(): string | undefined;
    private _volumeMode?;
    get volumeMode(): string;
    set volumeMode(value: string);
    resetVolumeMode(): void;
    get volumeModeInput(): string | undefined;
    private _volumeName?;
    get volumeName(): string;
    set volumeName(value: string);
    resetVolumeName(): void;
    get volumeNameInput(): string | undefined;
    private _resources;
    get resources(): PersistentVolumeClaimSpecResourcesOutputReference;
    putResources(value: PersistentVolumeClaimSpecResources): void;
    get resourcesInput(): PersistentVolumeClaimSpecResources | undefined;
    private _selector;
    get selector(): PersistentVolumeClaimSpecSelectorOutputReference;
    putSelector(value: PersistentVolumeClaimSpecSelector): void;
    resetSelector(): void;
    get selectorInput(): PersistentVolumeClaimSpecSelector | undefined;
}
export interface PersistentVolumeClaimTimeouts {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#create PersistentVolumeClaim#create}
    */
    readonly create?: string;
}
export declare function persistentVolumeClaimTimeoutsToTerraform(struct?: PersistentVolumeClaimTimeouts | cdktf.IResolvable): any;
export declare function persistentVolumeClaimTimeoutsToHclTerraform(struct?: PersistentVolumeClaimTimeouts | cdktf.IResolvable): any;
export declare class PersistentVolumeClaimTimeoutsOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    private resolvableValue?;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): PersistentVolumeClaimTimeouts | cdktf.IResolvable | undefined;
    set internalValue(value: PersistentVolumeClaimTimeouts | cdktf.IResolvable | undefined);
    private _create?;
    get create(): string;
    set create(value: string);
    resetCreate(): void;
    get createInput(): string | undefined;
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim kubernetes_persistent_volume_claim}
*/
export declare class PersistentVolumeClaim extends cdktf.TerraformResource {
    static readonly tfResourceType = "kubernetes_persistent_volume_claim";
    /**
    * Generates CDKTF code for importing a PersistentVolumeClaim resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the PersistentVolumeClaim to import
    * @param importFromId The id of the existing PersistentVolumeClaim that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the PersistentVolumeClaim to import is found
    */
    static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktf.TerraformProvider): cdktf.ImportableResource;
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim kubernetes_persistent_volume_claim} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options PersistentVolumeClaimConfig
    */
    constructor(scope: Construct, id: string, config: PersistentVolumeClaimConfig);
    private _id?;
    get id(): string;
    set id(value: string);
    resetId(): void;
    get idInput(): string | undefined;
    private _waitUntilBound?;
    get waitUntilBound(): boolean | cdktf.IResolvable;
    set waitUntilBound(value: boolean | cdktf.IResolvable);
    resetWaitUntilBound(): void;
    get waitUntilBoundInput(): boolean | cdktf.IResolvable | undefined;
    private _metadata;
    get metadata(): PersistentVolumeClaimMetadataOutputReference;
    putMetadata(value: PersistentVolumeClaimMetadata): void;
    get metadataInput(): PersistentVolumeClaimMetadata | undefined;
    private _spec;
    get spec(): PersistentVolumeClaimSpecOutputReference;
    putSpec(value: PersistentVolumeClaimSpec): void;
    get specInput(): PersistentVolumeClaimSpec | undefined;
    private _timeouts;
    get timeouts(): PersistentVolumeClaimTimeoutsOutputReference;
    putTimeouts(value: PersistentVolumeClaimTimeouts): void;
    resetTimeouts(): void;
    get timeoutsInput(): cdktf.IResolvable | PersistentVolumeClaimTimeouts | undefined;
    protected synthesizeAttributes(): {
        [name: string]: any;
    };
    protected synthesizeHclAttributes(): {
        [name: string]: any;
    };
}
//# sourceMappingURL=index.d.ts.map