import { Construct } from 'constructs';
import * as cdktf from 'cdktf';
export interface NamespaceConfig extends cdktf.TerraformMetaArguments {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#id Namespace#id}
    *
    * Please be aware that the id field is automatically added to all resources in Terraform providers using a Terraform provider SDK version below 2.
    * If you experience problems setting this value it might not be settable. Please take a look at the provider documentation to ensure it should be settable.
    */
    readonly id?: string;
    /**
    * Terraform will wait for the default service account to be created.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#wait_for_default_service_account Namespace#wait_for_default_service_account}
    */
    readonly waitForDefaultServiceAccount?: boolean | cdktf.IResolvable;
    /**
    * metadata block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#metadata Namespace#metadata}
    */
    readonly metadata: NamespaceMetadata;
    /**
    * timeouts block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#timeouts Namespace#timeouts}
    */
    readonly timeouts?: NamespaceTimeouts;
}
export interface NamespaceMetadata {
    /**
    * An unstructured key value map stored with the namespace that may be used to store arbitrary metadata. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#annotations Namespace#annotations}
    */
    readonly annotations?: {
        [key: string]: string;
    };
    /**
    * Prefix, used by the server, to generate a unique name ONLY IF the `name` field has not been provided. This value will also be combined with a unique suffix. More info: https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#idempotency
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#generate_name Namespace#generate_name}
    */
    readonly generateName?: string;
    /**
    * Map of string keys and values that can be used to organize and categorize (scope and select) the namespace. May match selectors of replication controllers and services. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#labels Namespace#labels}
    */
    readonly labels?: {
        [key: string]: string;
    };
    /**
    * Name of the namespace, must be unique. Cannot be updated. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#names
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#name Namespace#name}
    */
    readonly name?: string;
}
export declare function namespaceMetadataToTerraform(struct?: NamespaceMetadataOutputReference | NamespaceMetadata): any;
export declare function namespaceMetadataToHclTerraform(struct?: NamespaceMetadataOutputReference | NamespaceMetadata): any;
export declare class NamespaceMetadataOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): NamespaceMetadata | undefined;
    set internalValue(value: NamespaceMetadata | undefined);
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
    get resourceVersion(): string;
    get uid(): string;
}
export interface NamespaceTimeouts {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#delete Namespace#delete}
    */
    readonly delete?: string;
}
export declare function namespaceTimeoutsToTerraform(struct?: NamespaceTimeouts | cdktf.IResolvable): any;
export declare function namespaceTimeoutsToHclTerraform(struct?: NamespaceTimeouts | cdktf.IResolvable): any;
export declare class NamespaceTimeoutsOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    private resolvableValue?;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): NamespaceTimeouts | cdktf.IResolvable | undefined;
    set internalValue(value: NamespaceTimeouts | cdktf.IResolvable | undefined);
    private _delete?;
    get delete(): string;
    set delete(value: string);
    resetDelete(): void;
    get deleteInput(): string | undefined;
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace kubernetes_namespace}
*/
export declare class Namespace extends cdktf.TerraformResource {
    static readonly tfResourceType = "kubernetes_namespace";
    /**
    * Generates CDKTF code for importing a Namespace resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Namespace to import
    * @param importFromId The id of the existing Namespace that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Namespace to import is found
    */
    static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktf.TerraformProvider): cdktf.ImportableResource;
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace kubernetes_namespace} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options NamespaceConfig
    */
    constructor(scope: Construct, id: string, config: NamespaceConfig);
    private _id?;
    get id(): string;
    set id(value: string);
    resetId(): void;
    get idInput(): string | undefined;
    private _waitForDefaultServiceAccount?;
    get waitForDefaultServiceAccount(): boolean | cdktf.IResolvable;
    set waitForDefaultServiceAccount(value: boolean | cdktf.IResolvable);
    resetWaitForDefaultServiceAccount(): void;
    get waitForDefaultServiceAccountInput(): boolean | cdktf.IResolvable | undefined;
    private _metadata;
    get metadata(): NamespaceMetadataOutputReference;
    putMetadata(value: NamespaceMetadata): void;
    get metadataInput(): NamespaceMetadata | undefined;
    private _timeouts;
    get timeouts(): NamespaceTimeoutsOutputReference;
    putTimeouts(value: NamespaceTimeouts): void;
    resetTimeouts(): void;
    get timeoutsInput(): cdktf.IResolvable | NamespaceTimeouts | undefined;
    protected synthesizeAttributes(): {
        [name: string]: any;
    };
    protected synthesizeHclAttributes(): {
        [name: string]: any;
    };
}
//# sourceMappingURL=index.d.ts.map