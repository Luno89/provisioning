// https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret
// generated from terraform resource schema
import * as cdktf from 'cdktf';
export function secretMetadataToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        annotations: cdktf.hashMapper(cdktf.stringToTerraform)(struct.annotations),
        generate_name: cdktf.stringToTerraform(struct.generateName),
        labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.labels),
        name: cdktf.stringToTerraform(struct.name),
        namespace: cdktf.stringToTerraform(struct.namespace),
    };
}
export function secretMetadataToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        annotations: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.annotations),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        generate_name: {
            value: cdktf.stringToHclTerraform(struct.generateName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        labels: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.labels),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        namespace: {
            value: cdktf.stringToHclTerraform(struct.namespace),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class SecretMetadataOutputReference extends cdktf.ComplexObject {
    isEmptyObject = false;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource, terraformAttribute) {
        super(terraformResource, terraformAttribute, false, 0);
    }
    get internalValue() {
        let hasAnyValues = this.isEmptyObject;
        const internalValueResult = {};
        if (this._annotations !== undefined) {
            hasAnyValues = true;
            internalValueResult.annotations = this._annotations;
        }
        if (this._generateName !== undefined) {
            hasAnyValues = true;
            internalValueResult.generateName = this._generateName;
        }
        if (this._labels !== undefined) {
            hasAnyValues = true;
            internalValueResult.labels = this._labels;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._namespace !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespace = this._namespace;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._annotations = undefined;
            this._generateName = undefined;
            this._labels = undefined;
            this._name = undefined;
            this._namespace = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._annotations = value.annotations;
            this._generateName = value.generateName;
            this._labels = value.labels;
            this._name = value.name;
            this._namespace = value.namespace;
        }
    }
    // annotations - computed: false, optional: true, required: false
    _annotations;
    get annotations() {
        return this.getStringMapAttribute('annotations');
    }
    set annotations(value) {
        this._annotations = value;
    }
    resetAnnotations() {
        this._annotations = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get annotationsInput() {
        return this._annotations;
    }
    // generate_name - computed: false, optional: true, required: false
    _generateName;
    get generateName() {
        return this.getStringAttribute('generate_name');
    }
    set generateName(value) {
        this._generateName = value;
    }
    resetGenerateName() {
        this._generateName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get generateNameInput() {
        return this._generateName;
    }
    // generation - computed: true, optional: false, required: false
    get generation() {
        return this.getNumberAttribute('generation');
    }
    // labels - computed: false, optional: true, required: false
    _labels;
    get labels() {
        return this.getStringMapAttribute('labels');
    }
    set labels(value) {
        this._labels = value;
    }
    resetLabels() {
        this._labels = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get labelsInput() {
        return this._labels;
    }
    // name - computed: true, optional: true, required: false
    _name;
    get name() {
        return this.getStringAttribute('name');
    }
    set name(value) {
        this._name = value;
    }
    resetName() {
        this._name = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nameInput() {
        return this._name;
    }
    // namespace - computed: false, optional: true, required: false
    _namespace;
    get namespace() {
        return this.getStringAttribute('namespace');
    }
    set namespace(value) {
        this._namespace = value;
    }
    resetNamespace() {
        this._namespace = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespaceInput() {
        return this._namespace;
    }
    // resource_version - computed: true, optional: false, required: false
    get resourceVersion() {
        return this.getStringAttribute('resource_version');
    }
    // uid - computed: true, optional: false, required: false
    get uid() {
        return this.getStringAttribute('uid');
    }
}
export function secretTimeoutsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        create: cdktf.stringToTerraform(struct.create),
    };
}
export function secretTimeoutsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        create: {
            value: cdktf.stringToHclTerraform(struct.create),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class SecretTimeoutsOutputReference extends cdktf.ComplexObject {
    isEmptyObject = false;
    resolvableValue;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    */
    constructor(terraformResource, terraformAttribute) {
        super(terraformResource, terraformAttribute, false);
    }
    get internalValue() {
        if (this.resolvableValue) {
            return this.resolvableValue;
        }
        let hasAnyValues = this.isEmptyObject;
        const internalValueResult = {};
        if (this._create !== undefined) {
            hasAnyValues = true;
            internalValueResult.create = this._create;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._create = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._create = value.create;
        }
    }
    // create - computed: false, optional: true, required: false
    _create;
    get create() {
        return this.getStringAttribute('create');
    }
    set create(value) {
        this._create = value;
    }
    resetCreate() {
        this._create = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get createInput() {
        return this._create;
    }
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret kubernetes_secret}
*/
export class Secret extends cdktf.TerraformResource {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "kubernetes_secret";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a Secret resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Secret to import
    * @param importFromId The id of the existing Secret that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Secret to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "kubernetes_secret", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/secret kubernetes_secret} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options SecretConfig
    */
    constructor(scope, id, config) {
        super(scope, id, {
            terraformResourceType: 'kubernetes_secret',
            terraformGeneratorMetadata: {
                providerName: 'kubernetes',
                providerVersion: '2.38.0',
                providerVersionConstraint: '~> 2.0'
            },
            provider: config.provider,
            dependsOn: config.dependsOn,
            count: config.count,
            lifecycle: config.lifecycle,
            provisioners: config.provisioners,
            connection: config.connection,
            forEach: config.forEach
        });
        this._binaryData = config.binaryData;
        this._binaryDataWo = config.binaryDataWo;
        this._binaryDataWoRevision = config.binaryDataWoRevision;
        this._data = config.data;
        this._dataWo = config.dataWo;
        this._dataWoRevision = config.dataWoRevision;
        this._id = config.id;
        this._immutable = config.immutable;
        this._type = config.type;
        this._waitForServiceAccountToken = config.waitForServiceAccountToken;
        this._metadata.internalValue = config.metadata;
        this._timeouts.internalValue = config.timeouts;
    }
    // ==========
    // ATTRIBUTES
    // ==========
    // binary_data - computed: false, optional: true, required: false
    _binaryData;
    get binaryData() {
        return this.getStringMapAttribute('binary_data');
    }
    set binaryData(value) {
        this._binaryData = value;
    }
    resetBinaryData() {
        this._binaryData = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get binaryDataInput() {
        return this._binaryData;
    }
    // binary_data_wo - computed: false, optional: true, required: false
    _binaryDataWo;
    get binaryDataWo() {
        return this.getStringMapAttribute('binary_data_wo');
    }
    set binaryDataWo(value) {
        this._binaryDataWo = value;
    }
    resetBinaryDataWo() {
        this._binaryDataWo = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get binaryDataWoInput() {
        return this._binaryDataWo;
    }
    // binary_data_wo_revision - computed: false, optional: true, required: false
    _binaryDataWoRevision;
    get binaryDataWoRevision() {
        return this.getNumberAttribute('binary_data_wo_revision');
    }
    set binaryDataWoRevision(value) {
        this._binaryDataWoRevision = value;
    }
    resetBinaryDataWoRevision() {
        this._binaryDataWoRevision = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get binaryDataWoRevisionInput() {
        return this._binaryDataWoRevision;
    }
    // data - computed: true, optional: true, required: false
    _data;
    get data() {
        return this.getStringMapAttribute('data');
    }
    set data(value) {
        this._data = value;
    }
    resetData() {
        this._data = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get dataInput() {
        return this._data;
    }
    // data_wo - computed: false, optional: true, required: false
    _dataWo;
    get dataWo() {
        return this.getStringMapAttribute('data_wo');
    }
    set dataWo(value) {
        this._dataWo = value;
    }
    resetDataWo() {
        this._dataWo = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get dataWoInput() {
        return this._dataWo;
    }
    // data_wo_revision - computed: false, optional: true, required: false
    _dataWoRevision;
    get dataWoRevision() {
        return this.getNumberAttribute('data_wo_revision');
    }
    set dataWoRevision(value) {
        this._dataWoRevision = value;
    }
    resetDataWoRevision() {
        this._dataWoRevision = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get dataWoRevisionInput() {
        return this._dataWoRevision;
    }
    // id - computed: true, optional: true, required: false
    _id;
    get id() {
        return this.getStringAttribute('id');
    }
    set id(value) {
        this._id = value;
    }
    resetId() {
        this._id = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get idInput() {
        return this._id;
    }
    // immutable - computed: false, optional: true, required: false
    _immutable;
    get immutable() {
        return this.getBooleanAttribute('immutable');
    }
    set immutable(value) {
        this._immutable = value;
    }
    resetImmutable() {
        this._immutable = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get immutableInput() {
        return this._immutable;
    }
    // type - computed: false, optional: true, required: false
    _type;
    get type() {
        return this.getStringAttribute('type');
    }
    set type(value) {
        this._type = value;
    }
    resetType() {
        this._type = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get typeInput() {
        return this._type;
    }
    // wait_for_service_account_token - computed: false, optional: true, required: false
    _waitForServiceAccountToken;
    get waitForServiceAccountToken() {
        return this.getBooleanAttribute('wait_for_service_account_token');
    }
    set waitForServiceAccountToken(value) {
        this._waitForServiceAccountToken = value;
    }
    resetWaitForServiceAccountToken() {
        this._waitForServiceAccountToken = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get waitForServiceAccountTokenInput() {
        return this._waitForServiceAccountToken;
    }
    // metadata - computed: false, optional: false, required: true
    _metadata = new SecretMetadataOutputReference(this, "metadata");
    get metadata() {
        return this._metadata;
    }
    putMetadata(value) {
        this._metadata.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get metadataInput() {
        return this._metadata.internalValue;
    }
    // timeouts - computed: false, optional: true, required: false
    _timeouts = new SecretTimeoutsOutputReference(this, "timeouts");
    get timeouts() {
        return this._timeouts;
    }
    putTimeouts(value) {
        this._timeouts.internalValue = value;
    }
    resetTimeouts() {
        this._timeouts.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get timeoutsInput() {
        return this._timeouts.internalValue;
    }
    // =========
    // SYNTHESIS
    // =========
    synthesizeAttributes() {
        return {
            binary_data: cdktf.hashMapper(cdktf.stringToTerraform)(this._binaryData),
            binary_data_wo: cdktf.hashMapper(cdktf.stringToTerraform)(this._binaryDataWo),
            binary_data_wo_revision: cdktf.numberToTerraform(this._binaryDataWoRevision),
            data: cdktf.hashMapper(cdktf.stringToTerraform)(this._data),
            data_wo: cdktf.hashMapper(cdktf.stringToTerraform)(this._dataWo),
            data_wo_revision: cdktf.numberToTerraform(this._dataWoRevision),
            id: cdktf.stringToTerraform(this._id),
            immutable: cdktf.booleanToTerraform(this._immutable),
            type: cdktf.stringToTerraform(this._type),
            wait_for_service_account_token: cdktf.booleanToTerraform(this._waitForServiceAccountToken),
            metadata: secretMetadataToTerraform(this._metadata.internalValue),
            timeouts: secretTimeoutsToTerraform(this._timeouts.internalValue),
        };
    }
    synthesizeHclAttributes() {
        const attrs = {
            binary_data: {
                value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(this._binaryData),
                isBlock: false,
                type: "map",
                storageClassType: "stringMap",
            },
            binary_data_wo: {
                value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(this._binaryDataWo),
                isBlock: false,
                type: "map",
                storageClassType: "stringMap",
            },
            binary_data_wo_revision: {
                value: cdktf.numberToHclTerraform(this._binaryDataWoRevision),
                isBlock: false,
                type: "simple",
                storageClassType: "number",
            },
            data: {
                value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(this._data),
                isBlock: false,
                type: "map",
                storageClassType: "stringMap",
            },
            data_wo: {
                value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(this._dataWo),
                isBlock: false,
                type: "map",
                storageClassType: "stringMap",
            },
            data_wo_revision: {
                value: cdktf.numberToHclTerraform(this._dataWoRevision),
                isBlock: false,
                type: "simple",
                storageClassType: "number",
            },
            id: {
                value: cdktf.stringToHclTerraform(this._id),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            immutable: {
                value: cdktf.booleanToHclTerraform(this._immutable),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            type: {
                value: cdktf.stringToHclTerraform(this._type),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            wait_for_service_account_token: {
                value: cdktf.booleanToHclTerraform(this._waitForServiceAccountToken),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            metadata: {
                value: secretMetadataToHclTerraform(this._metadata.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "SecretMetadataList",
            },
            timeouts: {
                value: secretTimeoutsToHclTerraform(this._timeouts.internalValue),
                isBlock: true,
                type: "struct",
                storageClassType: "SecretTimeouts",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
