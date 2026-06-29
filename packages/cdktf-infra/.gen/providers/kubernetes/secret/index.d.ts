import { Construct } from 'constructs';
import * as cdktf from 'cdktf';
export interface SecretConfig extends cdktf.TerraformMetaArguments {
    /**
    * A map of the secret data in base64 encoding. Use this for binary data.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#binary_data Secret#binary_data}
    */
    readonly binaryData?: {
        [key: string]: string;
    };
    /**
    * A write-only map of the secret data in base64 encoding. Use this for binary data.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#binary_data_wo Secret#binary_data_wo}
    */
    readonly binaryDataWo?: {
        [key: string]: string;
    };
    /**
    * The current revision of the write-only "binary_data_wo" attribute. Incrementing this integer value will cause Terraform to update the write-only value.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#binary_data_wo_revision Secret#binary_data_wo_revision}
    */
    readonly binaryDataWoRevision?: number;
    /**
    * A map of the secret data.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#data Secret#data}
    */
    readonly data?: {
        [key: string]: string;
    };
    /**
    * A map write-only of the secret data.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#data_wo Secret#data_wo}
    */
    readonly dataWo?: {
        [key: string]: string;
    };
    /**
    * The current revision of the write-only "data_wo" attribute. Incrementing this integer value will cause Terraform to update the write-only value.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#data_wo_revision Secret#data_wo_revision}
    */
    readonly dataWoRevision?: number;
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#id Secret#id}
    *
    * Please be aware that the id field is automatically added to all resources in Terraform providers using a Terraform provider SDK version below 2.
    * If you experience problems setting this value it might not be settable. Please take a look at the provider documentation to ensure it should be settable.
    */
    readonly id?: string;
    /**
    * Ensures that data stored in the Secret cannot be updated (only object metadata can be modified).
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#immutable Secret#immutable}
    */
    readonly immutable?: boolean | cdktf.IResolvable;
    /**
    * Type of secret
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#type Secret#type}
    */
    readonly type?: string;
    /**
    * Terraform will wait for the service account token to be created.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#wait_for_service_account_token Secret#wait_for_service_account_token}
    */
    readonly waitForServiceAccountToken?: boolean | cdktf.IResolvable;
    /**
    * metadata block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#metadata Secret#metadata}
    */
    readonly metadata: SecretMetadata;
    /**
    * timeouts block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#timeouts Secret#timeouts}
    */
    readonly timeouts?: SecretTimeouts;
}
export interface SecretMetadata {
    /**
    * An unstructured key value map stored with the secret that may be used to store arbitrary metadata. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#annotations Secret#annotations}
    */
    readonly annotations?: {
        [key: string]: string;
    };
    /**
    * Prefix, used by the server, to generate a unique name ONLY IF the `name` field has not been provided. This value will also be combined with a unique suffix. More info: https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#idempotency
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#generate_name Secret#generate_name}
    */
    readonly generateName?: string;
    /**
    * Map of string keys and values that can be used to organize and categorize (scope and select) the secret. May match selectors of replication controllers and services. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#labels Secret#labels}
    */
    readonly labels?: {
        [key: string]: string;
    };
    /**
    * Name of the secret, must be unique. Cannot be updated. More info: https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#names
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#name Secret#name}
    */
    readonly name?: string;
    /**
    * Namespace defines the space within which name of the secret must be unique.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#namespace Secret#namespace}
    */
    readonly namespace?: string;
}
export declare function secretMetadataToTerraform(struct?: SecretMetadataOutputReference | SecretMetadata): any;
export declare function secretMetadataToHclTerraform(struct?: SecretMetadataOutputReference | SecretMetadata): any;
export declare class SecretMetadataOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): SecretMetadata | undefined;
    set internalValue(value: SecretMetadata | undefined);
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
export interface SecretTimeouts {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#create Secret#create}
    */
    readonly create?: string;
}
export declare function secretTimeoutsToTerraform(struct?: SecretTimeouts | cdktf.IResolvable): any;
export declare function secretTimeoutsToHclTerraform(struct?: SecretTimeouts | cdktf.IResolvable): any;
export declare class SecretTimeoutsOutputReference extends cdktf.ComplexObject {
    private isEmptyObject;
    private resolvableValue?;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource: cdktf.IInterpolatingParent, terraformAttribute: string);
    get internalValue(): SecretTimeouts | cdktf.IResolvable | undefined;
    set internalValue(value: SecretTimeouts | cdktf.IResolvable | undefined);
    private _create?;
    get create(): string;
    set create(value: string);
    resetCreate(): void;
    get createInput(): string | undefined;
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret kubernetes_secret}
*/
export declare class Secret extends cdktf.TerraformResource {
    static readonly tfResourceType = "kubernetes_secret";
    /**
    * Generates CDKTF code for importing a Secret resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Secret to import
    * @param importFromId The id of the existing Secret that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Secret to import is found
    */
    static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktf.TerraformProvider): cdktf.ImportableResource;
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret kubernetes_secret} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options SecretConfig
    */
    constructor(scope: Construct, id: string, config: SecretConfig);
    private _binaryData?;
    get binaryData(): {
        [key: string]: string;
    };
    set binaryData(value: {
        [key: string]: string;
    });
    resetBinaryData(): void;
    get binaryDataInput(): {
        [key: string]: string;
    } | undefined;
    private _binaryDataWo?;
    get binaryDataWo(): {
        [key: string]: string;
    };
    set binaryDataWo(value: {
        [key: string]: string;
    });
    resetBinaryDataWo(): void;
    get binaryDataWoInput(): {
        [key: string]: string;
    } | undefined;
    private _binaryDataWoRevision?;
    get binaryDataWoRevision(): number;
    set binaryDataWoRevision(value: number);
    resetBinaryDataWoRevision(): void;
    get binaryDataWoRevisionInput(): number | undefined;
    private _data?;
    get data(): {
        [key: string]: string;
    };
    set data(value: {
        [key: string]: string;
    });
    resetData(): void;
    get dataInput(): {
        [key: string]: string;
    } | undefined;
    private _dataWo?;
    get dataWo(): {
        [key: string]: string;
    };
    set dataWo(value: {
        [key: string]: string;
    });
    resetDataWo(): void;
    get dataWoInput(): {
        [key: string]: string;
    } | undefined;
    private _dataWoRevision?;
    get dataWoRevision(): number;
    set dataWoRevision(value: number);
    resetDataWoRevision(): void;
    get dataWoRevisionInput(): number | undefined;
    private _id?;
    get id(): string;
    set id(value: string);
    resetId(): void;
    get idInput(): string | undefined;
    private _immutable?;
    get immutable(): boolean | cdktf.IResolvable;
    set immutable(value: boolean | cdktf.IResolvable);
    resetImmutable(): void;
    get immutableInput(): boolean | cdktf.IResolvable | undefined;
    private _type?;
    get type(): string;
    set type(value: string);
    resetType(): void;
    get typeInput(): string | undefined;
    private _waitForServiceAccountToken?;
    get waitForServiceAccountToken(): boolean | cdktf.IResolvable;
    set waitForServiceAccountToken(value: boolean | cdktf.IResolvable);
    resetWaitForServiceAccountToken(): void;
    get waitForServiceAccountTokenInput(): boolean | cdktf.IResolvable | undefined;
    private _metadata;
    get metadata(): SecretMetadataOutputReference;
    putMetadata(value: SecretMetadata): void;
    get metadataInput(): SecretMetadata | undefined;
    private _timeouts;
    get timeouts(): SecretTimeoutsOutputReference;
    putTimeouts(value: SecretTimeouts): void;
    resetTimeouts(): void;
    get timeoutsInput(): cdktf.IResolvable | SecretTimeouts | undefined;
    protected synthesizeAttributes(): {
        [name: string]: any;
    };
    protected synthesizeHclAttributes(): {
        [name: string]: any;
    };
}
//# sourceMappingURL=index.d.ts.map