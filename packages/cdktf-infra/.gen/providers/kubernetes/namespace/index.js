// https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace
// generated from terraform resource schema
import * as cdktf from 'cdktf';
export function namespaceMetadataToTerraform(struct) {
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
    };
}
export function namespaceMetadataToHclTerraform(struct) {
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class NamespaceMetadataOutputReference extends cdktf.ComplexObject {
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
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._annotations = undefined;
            this._generateName = undefined;
            this._labels = undefined;
            this._name = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._annotations = value.annotations;
            this._generateName = value.generateName;
            this._labels = value.labels;
            this._name = value.name;
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
    // resource_version - computed: true, optional: false, required: false
    get resourceVersion() {
        return this.getStringAttribute('resource_version');
    }
    // uid - computed: true, optional: false, required: false
    get uid() {
        return this.getStringAttribute('uid');
    }
}
export function namespaceTimeoutsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        delete: cdktf.stringToTerraform(struct.delete),
    };
}
export function namespaceTimeoutsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        delete: {
            value: cdktf.stringToHclTerraform(struct.delete),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class NamespaceTimeoutsOutputReference extends cdktf.ComplexObject {
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
        if (this._delete !== undefined) {
            hasAnyValues = true;
            internalValueResult.delete = this._delete;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._delete = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._delete = value.delete;
        }
    }
    // delete - computed: false, optional: true, required: false
    _delete;
    get delete() {
        return this.getStringAttribute('delete');
    }
    set delete(value) {
        this._delete = value;
    }
    resetDelete() {
        this._delete = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get deleteInput() {
        return this._delete;
    }
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace kubernetes_namespace}
*/
export class Namespace extends cdktf.TerraformResource {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "kubernetes_namespace";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a Namespace resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Namespace to import
    * @param importFromId The id of the existing Namespace that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Namespace to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "kubernetes_namespace", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/namespace kubernetes_namespace} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options NamespaceConfig
    */
    constructor(scope, id, config) {
        super(scope, id, {
            terraformResourceType: 'kubernetes_namespace',
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
        this._id = config.id;
        this._waitForDefaultServiceAccount = config.waitForDefaultServiceAccount;
        this._metadata.internalValue = config.metadata;
        this._timeouts.internalValue = config.timeouts;
    }
    // ==========
    // ATTRIBUTES
    // ==========
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
    // wait_for_default_service_account - computed: false, optional: true, required: false
    _waitForDefaultServiceAccount;
    get waitForDefaultServiceAccount() {
        return this.getBooleanAttribute('wait_for_default_service_account');
    }
    set waitForDefaultServiceAccount(value) {
        this._waitForDefaultServiceAccount = value;
    }
    resetWaitForDefaultServiceAccount() {
        this._waitForDefaultServiceAccount = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get waitForDefaultServiceAccountInput() {
        return this._waitForDefaultServiceAccount;
    }
    // metadata - computed: false, optional: false, required: true
    _metadata = new NamespaceMetadataOutputReference(this, "metadata");
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
    _timeouts = new NamespaceTimeoutsOutputReference(this, "timeouts");
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
            id: cdktf.stringToTerraform(this._id),
            wait_for_default_service_account: cdktf.booleanToTerraform(this._waitForDefaultServiceAccount),
            metadata: namespaceMetadataToTerraform(this._metadata.internalValue),
            timeouts: namespaceTimeoutsToTerraform(this._timeouts.internalValue),
        };
    }
    synthesizeHclAttributes() {
        const attrs = {
            id: {
                value: cdktf.stringToHclTerraform(this._id),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            wait_for_default_service_account: {
                value: cdktf.booleanToHclTerraform(this._waitForDefaultServiceAccount),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            metadata: {
                value: namespaceMetadataToHclTerraform(this._metadata.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "NamespaceMetadataList",
            },
            timeouts: {
                value: namespaceTimeoutsToHclTerraform(this._timeouts.internalValue),
                isBlock: true,
                type: "struct",
                storageClassType: "NamespaceTimeouts",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
