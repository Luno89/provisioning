// https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs/resources/release
// generated from terraform resource schema
import * as cdktf from 'cdktf';
export function releaseMetadataToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {};
}
export function releaseMetadataToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {};
    return attrs;
}
export class ReleaseMetadataOutputReference extends cdktf.ComplexObject {
    isEmptyObject = false;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, complexObjectIndex, complexObjectIsFromSet) {
        super(terraformResource, terraformAttribute, complexObjectIsFromSet, complexObjectIndex);
    }
    get internalValue() {
        let hasAnyValues = this.isEmptyObject;
        const internalValueResult = {};
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
        }
    }
    // app_version - computed: true, optional: false, required: false
    get appVersion() {
        return this.getStringAttribute('app_version');
    }
    // chart - computed: true, optional: false, required: false
    get chart() {
        return this.getStringAttribute('chart');
    }
    // first_deployed - computed: true, optional: false, required: false
    get firstDeployed() {
        return this.getNumberAttribute('first_deployed');
    }
    // last_deployed - computed: true, optional: false, required: false
    get lastDeployed() {
        return this.getNumberAttribute('last_deployed');
    }
    // name - computed: true, optional: false, required: false
    get name() {
        return this.getStringAttribute('name');
    }
    // namespace - computed: true, optional: false, required: false
    get namespace() {
        return this.getStringAttribute('namespace');
    }
    // notes - computed: true, optional: false, required: false
    get notes() {
        return this.getStringAttribute('notes');
    }
    // revision - computed: true, optional: false, required: false
    get revision() {
        return this.getNumberAttribute('revision');
    }
    // values - computed: true, optional: false, required: false
    get values() {
        return this.getStringAttribute('values');
    }
    // version - computed: true, optional: false, required: false
    get version() {
        return this.getStringAttribute('version');
    }
}
export class ReleaseMetadataList extends cdktf.ComplexList {
    terraformResource;
    terraformAttribute;
    wrapsSet;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, wrapsSet) {
        super(terraformResource, terraformAttribute, wrapsSet);
        this.terraformResource = terraformResource;
        this.terraformAttribute = terraformAttribute;
        this.wrapsSet = wrapsSet;
    }
    /**
    * @param index the index of the item to return
    */
    get(index) {
        return new ReleaseMetadataOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function releasePostrenderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        args: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.args),
        binary_path: cdktf.stringToTerraform(struct.binaryPath),
    };
}
export function releasePostrenderToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        args: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.args),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        binary_path: {
            value: cdktf.stringToHclTerraform(struct.binaryPath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ReleasePostrenderOutputReference extends cdktf.ComplexObject {
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
        if (this._args !== undefined) {
            hasAnyValues = true;
            internalValueResult.args = this._args;
        }
        if (this._binaryPath !== undefined) {
            hasAnyValues = true;
            internalValueResult.binaryPath = this._binaryPath;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._args = undefined;
            this._binaryPath = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._args = value.args;
            this._binaryPath = value.binaryPath;
        }
    }
    // args - computed: false, optional: true, required: false
    _args;
    get args() {
        return this.getListAttribute('args');
    }
    set args(value) {
        this._args = value;
    }
    resetArgs() {
        this._args = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get argsInput() {
        return this._args;
    }
    // binary_path - computed: false, optional: false, required: true
    _binaryPath;
    get binaryPath() {
        return this.getStringAttribute('binary_path');
    }
    set binaryPath(value) {
        this._binaryPath = value;
    }
    // Temporarily expose input value. Use with caution.
    get binaryPathInput() {
        return this._binaryPath;
    }
}
export function releaseSetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        type: cdktf.stringToTerraform(struct.type),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function releaseSetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        type: {
            value: cdktf.stringToHclTerraform(struct.type),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        value: {
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ReleaseSetOutputReference extends cdktf.ComplexObject {
    isEmptyObject = false;
    resolvableValue;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, complexObjectIndex, complexObjectIsFromSet) {
        super(terraformResource, terraformAttribute, complexObjectIsFromSet, complexObjectIndex);
    }
    get internalValue() {
        if (this.resolvableValue) {
            return this.resolvableValue;
        }
        let hasAnyValues = this.isEmptyObject;
        const internalValueResult = {};
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._type !== undefined) {
            hasAnyValues = true;
            internalValueResult.type = this._type;
        }
        if (this._value !== undefined) {
            hasAnyValues = true;
            internalValueResult.value = this._value;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._type = undefined;
            this._value = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._name = value.name;
            this._type = value.type;
            this._value = value.value;
        }
    }
    // name - computed: false, optional: false, required: true
    _name;
    get name() {
        return this.getStringAttribute('name');
    }
    set name(value) {
        this._name = value;
    }
    // Temporarily expose input value. Use with caution.
    get nameInput() {
        return this._name;
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
    // value - computed: false, optional: false, required: true
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class ReleaseSetList extends cdktf.ComplexList {
    terraformResource;
    terraformAttribute;
    wrapsSet;
    internalValue;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, wrapsSet) {
        super(terraformResource, terraformAttribute, wrapsSet);
        this.terraformResource = terraformResource;
        this.terraformAttribute = terraformAttribute;
        this.wrapsSet = wrapsSet;
    }
    /**
    * @param index the index of the item to return
    */
    get(index) {
        return new ReleaseSetOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function releaseSetListStructToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.value),
    };
}
export function releaseSetListStructToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        value: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.value),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ReleaseSetListStructOutputReference extends cdktf.ComplexObject {
    isEmptyObject = false;
    resolvableValue;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, complexObjectIndex, complexObjectIsFromSet) {
        super(terraformResource, terraformAttribute, complexObjectIsFromSet, complexObjectIndex);
    }
    get internalValue() {
        if (this.resolvableValue) {
            return this.resolvableValue;
        }
        let hasAnyValues = this.isEmptyObject;
        const internalValueResult = {};
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._value !== undefined) {
            hasAnyValues = true;
            internalValueResult.value = this._value;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._value = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._name = value.name;
            this._value = value.value;
        }
    }
    // name - computed: false, optional: false, required: true
    _name;
    get name() {
        return this.getStringAttribute('name');
    }
    set name(value) {
        this._name = value;
    }
    // Temporarily expose input value. Use with caution.
    get nameInput() {
        return this._name;
    }
    // value - computed: false, optional: false, required: true
    _value;
    get value() {
        return this.getListAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class ReleaseSetListStructList extends cdktf.ComplexList {
    terraformResource;
    terraformAttribute;
    wrapsSet;
    internalValue;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, wrapsSet) {
        super(terraformResource, terraformAttribute, wrapsSet);
        this.terraformResource = terraformResource;
        this.terraformAttribute = terraformAttribute;
        this.wrapsSet = wrapsSet;
    }
    /**
    * @param index the index of the item to return
    */
    get(index) {
        return new ReleaseSetListStructOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function releaseSetSensitiveToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        type: cdktf.stringToTerraform(struct.type),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function releaseSetSensitiveToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        type: {
            value: cdktf.stringToHclTerraform(struct.type),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        value: {
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ReleaseSetSensitiveOutputReference extends cdktf.ComplexObject {
    isEmptyObject = false;
    resolvableValue;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param complexObjectIndex the index of this item in the list
    * @param complexObjectIsFromSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, complexObjectIndex, complexObjectIsFromSet) {
        super(terraformResource, terraformAttribute, complexObjectIsFromSet, complexObjectIndex);
    }
    get internalValue() {
        if (this.resolvableValue) {
            return this.resolvableValue;
        }
        let hasAnyValues = this.isEmptyObject;
        const internalValueResult = {};
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._type !== undefined) {
            hasAnyValues = true;
            internalValueResult.type = this._type;
        }
        if (this._value !== undefined) {
            hasAnyValues = true;
            internalValueResult.value = this._value;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._type = undefined;
            this._value = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._name = value.name;
            this._type = value.type;
            this._value = value.value;
        }
    }
    // name - computed: false, optional: false, required: true
    _name;
    get name() {
        return this.getStringAttribute('name');
    }
    set name(value) {
        this._name = value;
    }
    // Temporarily expose input value. Use with caution.
    get nameInput() {
        return this._name;
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
    // value - computed: false, optional: false, required: true
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class ReleaseSetSensitiveList extends cdktf.ComplexList {
    terraformResource;
    terraformAttribute;
    wrapsSet;
    internalValue;
    /**
    * @param terraformResource The parent resource
    * @param terraformAttribute The attribute on the parent resource this class is referencing
    * @param wrapsSet whether the list is wrapping a set (will add tolist() to be able to access an item via an index)
    */
    constructor(terraformResource, terraformAttribute, wrapsSet) {
        super(terraformResource, terraformAttribute, wrapsSet);
        this.terraformResource = terraformResource;
        this.terraformAttribute = terraformAttribute;
        this.wrapsSet = wrapsSet;
    }
    /**
    * @param index the index of the item to return
    */
    get(index) {
        return new ReleaseSetSensitiveOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs/resources/release helm_release}
*/
export class Release extends cdktf.TerraformResource {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "helm_release";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a Release resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Release to import
    * @param importFromId The id of the existing Release that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs/resources/release#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Release to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "helm_release", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/helm/2.17.0/docs/resources/release helm_release} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options ReleaseConfig
    */
    constructor(scope, id, config) {
        super(scope, id, {
            terraformResourceType: 'helm_release',
            terraformGeneratorMetadata: {
                providerName: 'helm',
                providerVersion: '2.17.0',
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
        this._atomic = config.atomic;
        this._chart = config.chart;
        this._cleanupOnFail = config.cleanupOnFail;
        this._createNamespace = config.createNamespace;
        this._dependencyUpdate = config.dependencyUpdate;
        this._description = config.description;
        this._devel = config.devel;
        this._disableCrdHooks = config.disableCrdHooks;
        this._disableOpenapiValidation = config.disableOpenapiValidation;
        this._disableWebhooks = config.disableWebhooks;
        this._forceUpdate = config.forceUpdate;
        this._id = config.id;
        this._keyring = config.keyring;
        this._lint = config.lint;
        this._maxHistory = config.maxHistory;
        this._name = config.name;
        this._namespace = config.namespace;
        this._passCredentials = config.passCredentials;
        this._recreatePods = config.recreatePods;
        this._renderSubchartNotes = config.renderSubchartNotes;
        this._replace = config.replace;
        this._repository = config.repository;
        this._repositoryCaFile = config.repositoryCaFile;
        this._repositoryCertFile = config.repositoryCertFile;
        this._repositoryKeyFile = config.repositoryKeyFile;
        this._repositoryPassword = config.repositoryPassword;
        this._repositoryUsername = config.repositoryUsername;
        this._resetValues = config.resetValues;
        this._reuseValues = config.reuseValues;
        this._skipCrds = config.skipCrds;
        this._timeout = config.timeout;
        this._upgradeInstall = config.upgradeInstall;
        this._values = config.values;
        this._verify = config.verify;
        this._version = config.version;
        this._wait = config.wait;
        this._waitForJobs = config.waitForJobs;
        this._postrender.internalValue = config.postrender;
        this._set.internalValue = config.set;
        this._setList.internalValue = config.setList;
        this._setSensitive.internalValue = config.setSensitive;
    }
    // ==========
    // ATTRIBUTES
    // ==========
    // atomic - computed: false, optional: true, required: false
    _atomic;
    get atomic() {
        return this.getBooleanAttribute('atomic');
    }
    set atomic(value) {
        this._atomic = value;
    }
    resetAtomic() {
        this._atomic = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get atomicInput() {
        return this._atomic;
    }
    // chart - computed: false, optional: false, required: true
    _chart;
    get chart() {
        return this.getStringAttribute('chart');
    }
    set chart(value) {
        this._chart = value;
    }
    // Temporarily expose input value. Use with caution.
    get chartInput() {
        return this._chart;
    }
    // cleanup_on_fail - computed: false, optional: true, required: false
    _cleanupOnFail;
    get cleanupOnFail() {
        return this.getBooleanAttribute('cleanup_on_fail');
    }
    set cleanupOnFail(value) {
        this._cleanupOnFail = value;
    }
    resetCleanupOnFail() {
        this._cleanupOnFail = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get cleanupOnFailInput() {
        return this._cleanupOnFail;
    }
    // create_namespace - computed: false, optional: true, required: false
    _createNamespace;
    get createNamespace() {
        return this.getBooleanAttribute('create_namespace');
    }
    set createNamespace(value) {
        this._createNamespace = value;
    }
    resetCreateNamespace() {
        this._createNamespace = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get createNamespaceInput() {
        return this._createNamespace;
    }
    // dependency_update - computed: false, optional: true, required: false
    _dependencyUpdate;
    get dependencyUpdate() {
        return this.getBooleanAttribute('dependency_update');
    }
    set dependencyUpdate(value) {
        this._dependencyUpdate = value;
    }
    resetDependencyUpdate() {
        this._dependencyUpdate = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get dependencyUpdateInput() {
        return this._dependencyUpdate;
    }
    // description - computed: false, optional: true, required: false
    _description;
    get description() {
        return this.getStringAttribute('description');
    }
    set description(value) {
        this._description = value;
    }
    resetDescription() {
        this._description = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get descriptionInput() {
        return this._description;
    }
    // devel - computed: false, optional: true, required: false
    _devel;
    get devel() {
        return this.getBooleanAttribute('devel');
    }
    set devel(value) {
        this._devel = value;
    }
    resetDevel() {
        this._devel = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get develInput() {
        return this._devel;
    }
    // disable_crd_hooks - computed: false, optional: true, required: false
    _disableCrdHooks;
    get disableCrdHooks() {
        return this.getBooleanAttribute('disable_crd_hooks');
    }
    set disableCrdHooks(value) {
        this._disableCrdHooks = value;
    }
    resetDisableCrdHooks() {
        this._disableCrdHooks = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get disableCrdHooksInput() {
        return this._disableCrdHooks;
    }
    // disable_openapi_validation - computed: false, optional: true, required: false
    _disableOpenapiValidation;
    get disableOpenapiValidation() {
        return this.getBooleanAttribute('disable_openapi_validation');
    }
    set disableOpenapiValidation(value) {
        this._disableOpenapiValidation = value;
    }
    resetDisableOpenapiValidation() {
        this._disableOpenapiValidation = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get disableOpenapiValidationInput() {
        return this._disableOpenapiValidation;
    }
    // disable_webhooks - computed: false, optional: true, required: false
    _disableWebhooks;
    get disableWebhooks() {
        return this.getBooleanAttribute('disable_webhooks');
    }
    set disableWebhooks(value) {
        this._disableWebhooks = value;
    }
    resetDisableWebhooks() {
        this._disableWebhooks = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get disableWebhooksInput() {
        return this._disableWebhooks;
    }
    // force_update - computed: false, optional: true, required: false
    _forceUpdate;
    get forceUpdate() {
        return this.getBooleanAttribute('force_update');
    }
    set forceUpdate(value) {
        this._forceUpdate = value;
    }
    resetForceUpdate() {
        this._forceUpdate = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get forceUpdateInput() {
        return this._forceUpdate;
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
    // keyring - computed: false, optional: true, required: false
    _keyring;
    get keyring() {
        return this.getStringAttribute('keyring');
    }
    set keyring(value) {
        this._keyring = value;
    }
    resetKeyring() {
        this._keyring = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get keyringInput() {
        return this._keyring;
    }
    // lint - computed: false, optional: true, required: false
    _lint;
    get lint() {
        return this.getBooleanAttribute('lint');
    }
    set lint(value) {
        this._lint = value;
    }
    resetLint() {
        this._lint = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get lintInput() {
        return this._lint;
    }
    // manifest - computed: true, optional: false, required: false
    get manifest() {
        return this.getStringAttribute('manifest');
    }
    // max_history - computed: false, optional: true, required: false
    _maxHistory;
    get maxHistory() {
        return this.getNumberAttribute('max_history');
    }
    set maxHistory(value) {
        this._maxHistory = value;
    }
    resetMaxHistory() {
        this._maxHistory = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get maxHistoryInput() {
        return this._maxHistory;
    }
    // metadata - computed: true, optional: false, required: false
    _metadata = new ReleaseMetadataList(this, "metadata", false);
    get metadata() {
        return this._metadata;
    }
    // name - computed: false, optional: false, required: true
    _name;
    get name() {
        return this.getStringAttribute('name');
    }
    set name(value) {
        this._name = value;
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
    // pass_credentials - computed: false, optional: true, required: false
    _passCredentials;
    get passCredentials() {
        return this.getBooleanAttribute('pass_credentials');
    }
    set passCredentials(value) {
        this._passCredentials = value;
    }
    resetPassCredentials() {
        this._passCredentials = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get passCredentialsInput() {
        return this._passCredentials;
    }
    // recreate_pods - computed: false, optional: true, required: false
    _recreatePods;
    get recreatePods() {
        return this.getBooleanAttribute('recreate_pods');
    }
    set recreatePods(value) {
        this._recreatePods = value;
    }
    resetRecreatePods() {
        this._recreatePods = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get recreatePodsInput() {
        return this._recreatePods;
    }
    // render_subchart_notes - computed: false, optional: true, required: false
    _renderSubchartNotes;
    get renderSubchartNotes() {
        return this.getBooleanAttribute('render_subchart_notes');
    }
    set renderSubchartNotes(value) {
        this._renderSubchartNotes = value;
    }
    resetRenderSubchartNotes() {
        this._renderSubchartNotes = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get renderSubchartNotesInput() {
        return this._renderSubchartNotes;
    }
    // replace - computed: false, optional: true, required: false
    _replace;
    get replace() {
        return this.getBooleanAttribute('replace');
    }
    set replace(value) {
        this._replace = value;
    }
    resetReplace() {
        this._replace = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get replaceInput() {
        return this._replace;
    }
    // repository - computed: false, optional: true, required: false
    _repository;
    get repository() {
        return this.getStringAttribute('repository');
    }
    set repository(value) {
        this._repository = value;
    }
    resetRepository() {
        this._repository = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryInput() {
        return this._repository;
    }
    // repository_ca_file - computed: false, optional: true, required: false
    _repositoryCaFile;
    get repositoryCaFile() {
        return this.getStringAttribute('repository_ca_file');
    }
    set repositoryCaFile(value) {
        this._repositoryCaFile = value;
    }
    resetRepositoryCaFile() {
        this._repositoryCaFile = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryCaFileInput() {
        return this._repositoryCaFile;
    }
    // repository_cert_file - computed: false, optional: true, required: false
    _repositoryCertFile;
    get repositoryCertFile() {
        return this.getStringAttribute('repository_cert_file');
    }
    set repositoryCertFile(value) {
        this._repositoryCertFile = value;
    }
    resetRepositoryCertFile() {
        this._repositoryCertFile = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryCertFileInput() {
        return this._repositoryCertFile;
    }
    // repository_key_file - computed: false, optional: true, required: false
    _repositoryKeyFile;
    get repositoryKeyFile() {
        return this.getStringAttribute('repository_key_file');
    }
    set repositoryKeyFile(value) {
        this._repositoryKeyFile = value;
    }
    resetRepositoryKeyFile() {
        this._repositoryKeyFile = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryKeyFileInput() {
        return this._repositoryKeyFile;
    }
    // repository_password - computed: false, optional: true, required: false
    _repositoryPassword;
    get repositoryPassword() {
        return this.getStringAttribute('repository_password');
    }
    set repositoryPassword(value) {
        this._repositoryPassword = value;
    }
    resetRepositoryPassword() {
        this._repositoryPassword = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryPasswordInput() {
        return this._repositoryPassword;
    }
    // repository_username - computed: false, optional: true, required: false
    _repositoryUsername;
    get repositoryUsername() {
        return this.getStringAttribute('repository_username');
    }
    set repositoryUsername(value) {
        this._repositoryUsername = value;
    }
    resetRepositoryUsername() {
        this._repositoryUsername = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get repositoryUsernameInput() {
        return this._repositoryUsername;
    }
    // reset_values - computed: false, optional: true, required: false
    _resetValues;
    get resetValues() {
        return this.getBooleanAttribute('reset_values');
    }
    set resetValues(value) {
        this._resetValues = value;
    }
    resetResetValues() {
        this._resetValues = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get resetValuesInput() {
        return this._resetValues;
    }
    // reuse_values - computed: false, optional: true, required: false
    _reuseValues;
    get reuseValues() {
        return this.getBooleanAttribute('reuse_values');
    }
    set reuseValues(value) {
        this._reuseValues = value;
    }
    resetReuseValues() {
        this._reuseValues = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get reuseValuesInput() {
        return this._reuseValues;
    }
    // skip_crds - computed: false, optional: true, required: false
    _skipCrds;
    get skipCrds() {
        return this.getBooleanAttribute('skip_crds');
    }
    set skipCrds(value) {
        this._skipCrds = value;
    }
    resetSkipCrds() {
        this._skipCrds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get skipCrdsInput() {
        return this._skipCrds;
    }
    // status - computed: true, optional: false, required: false
    get status() {
        return this.getStringAttribute('status');
    }
    // timeout - computed: false, optional: true, required: false
    _timeout;
    get timeout() {
        return this.getNumberAttribute('timeout');
    }
    set timeout(value) {
        this._timeout = value;
    }
    resetTimeout() {
        this._timeout = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get timeoutInput() {
        return this._timeout;
    }
    // upgrade_install - computed: false, optional: true, required: false
    _upgradeInstall;
    get upgradeInstall() {
        return this.getBooleanAttribute('upgrade_install');
    }
    set upgradeInstall(value) {
        this._upgradeInstall = value;
    }
    resetUpgradeInstall() {
        this._upgradeInstall = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get upgradeInstallInput() {
        return this._upgradeInstall;
    }
    // values - computed: false, optional: true, required: false
    _values;
    get values() {
        return this.getListAttribute('values');
    }
    set values(value) {
        this._values = value;
    }
    resetTfValues() {
        this._values = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valuesInput() {
        return this._values;
    }
    // verify - computed: false, optional: true, required: false
    _verify;
    get verify() {
        return this.getBooleanAttribute('verify');
    }
    set verify(value) {
        this._verify = value;
    }
    resetVerify() {
        this._verify = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get verifyInput() {
        return this._verify;
    }
    // version - computed: true, optional: true, required: false
    _version;
    get version() {
        return this.getStringAttribute('version');
    }
    set version(value) {
        this._version = value;
    }
    resetVersion() {
        this._version = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get versionInput() {
        return this._version;
    }
    // wait - computed: false, optional: true, required: false
    _wait;
    get wait() {
        return this.getBooleanAttribute('wait');
    }
    set wait(value) {
        this._wait = value;
    }
    resetWait() {
        this._wait = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get waitInput() {
        return this._wait;
    }
    // wait_for_jobs - computed: false, optional: true, required: false
    _waitForJobs;
    get waitForJobs() {
        return this.getBooleanAttribute('wait_for_jobs');
    }
    set waitForJobs(value) {
        this._waitForJobs = value;
    }
    resetWaitForJobs() {
        this._waitForJobs = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get waitForJobsInput() {
        return this._waitForJobs;
    }
    // postrender - computed: false, optional: true, required: false
    _postrender = new ReleasePostrenderOutputReference(this, "postrender");
    get postrender() {
        return this._postrender;
    }
    putPostrender(value) {
        this._postrender.internalValue = value;
    }
    resetPostrender() {
        this._postrender.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get postrenderInput() {
        return this._postrender.internalValue;
    }
    // set - computed: false, optional: true, required: false
    _set = new ReleaseSetList(this, "set", true);
    get set() {
        return this._set;
    }
    putSet(value) {
        this._set.internalValue = value;
    }
    resetSet() {
        this._set.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get setInput() {
        return this._set.internalValue;
    }
    // set_list - computed: false, optional: true, required: false
    _setList = new ReleaseSetListStructList(this, "set_list", false);
    get setList() {
        return this._setList;
    }
    putSetList(value) {
        this._setList.internalValue = value;
    }
    resetSetList() {
        this._setList.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get setListInput() {
        return this._setList.internalValue;
    }
    // set_sensitive - computed: false, optional: true, required: false
    _setSensitive = new ReleaseSetSensitiveList(this, "set_sensitive", true);
    get setSensitive() {
        return this._setSensitive;
    }
    putSetSensitive(value) {
        this._setSensitive.internalValue = value;
    }
    resetSetSensitive() {
        this._setSensitive.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get setSensitiveInput() {
        return this._setSensitive.internalValue;
    }
    // =========
    // SYNTHESIS
    // =========
    synthesizeAttributes() {
        return {
            atomic: cdktf.booleanToTerraform(this._atomic),
            chart: cdktf.stringToTerraform(this._chart),
            cleanup_on_fail: cdktf.booleanToTerraform(this._cleanupOnFail),
            create_namespace: cdktf.booleanToTerraform(this._createNamespace),
            dependency_update: cdktf.booleanToTerraform(this._dependencyUpdate),
            description: cdktf.stringToTerraform(this._description),
            devel: cdktf.booleanToTerraform(this._devel),
            disable_crd_hooks: cdktf.booleanToTerraform(this._disableCrdHooks),
            disable_openapi_validation: cdktf.booleanToTerraform(this._disableOpenapiValidation),
            disable_webhooks: cdktf.booleanToTerraform(this._disableWebhooks),
            force_update: cdktf.booleanToTerraform(this._forceUpdate),
            id: cdktf.stringToTerraform(this._id),
            keyring: cdktf.stringToTerraform(this._keyring),
            lint: cdktf.booleanToTerraform(this._lint),
            max_history: cdktf.numberToTerraform(this._maxHistory),
            name: cdktf.stringToTerraform(this._name),
            namespace: cdktf.stringToTerraform(this._namespace),
            pass_credentials: cdktf.booleanToTerraform(this._passCredentials),
            recreate_pods: cdktf.booleanToTerraform(this._recreatePods),
            render_subchart_notes: cdktf.booleanToTerraform(this._renderSubchartNotes),
            replace: cdktf.booleanToTerraform(this._replace),
            repository: cdktf.stringToTerraform(this._repository),
            repository_ca_file: cdktf.stringToTerraform(this._repositoryCaFile),
            repository_cert_file: cdktf.stringToTerraform(this._repositoryCertFile),
            repository_key_file: cdktf.stringToTerraform(this._repositoryKeyFile),
            repository_password: cdktf.stringToTerraform(this._repositoryPassword),
            repository_username: cdktf.stringToTerraform(this._repositoryUsername),
            reset_values: cdktf.booleanToTerraform(this._resetValues),
            reuse_values: cdktf.booleanToTerraform(this._reuseValues),
            skip_crds: cdktf.booleanToTerraform(this._skipCrds),
            timeout: cdktf.numberToTerraform(this._timeout),
            upgrade_install: cdktf.booleanToTerraform(this._upgradeInstall),
            values: cdktf.listMapper(cdktf.stringToTerraform, false)(this._values),
            verify: cdktf.booleanToTerraform(this._verify),
            version: cdktf.stringToTerraform(this._version),
            wait: cdktf.booleanToTerraform(this._wait),
            wait_for_jobs: cdktf.booleanToTerraform(this._waitForJobs),
            postrender: releasePostrenderToTerraform(this._postrender.internalValue),
            set: cdktf.listMapper(releaseSetToTerraform, true)(this._set.internalValue),
            set_list: cdktf.listMapper(releaseSetListStructToTerraform, true)(this._setList.internalValue),
            set_sensitive: cdktf.listMapper(releaseSetSensitiveToTerraform, true)(this._setSensitive.internalValue),
        };
    }
    synthesizeHclAttributes() {
        const attrs = {
            atomic: {
                value: cdktf.booleanToHclTerraform(this._atomic),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            chart: {
                value: cdktf.stringToHclTerraform(this._chart),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            cleanup_on_fail: {
                value: cdktf.booleanToHclTerraform(this._cleanupOnFail),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            create_namespace: {
                value: cdktf.booleanToHclTerraform(this._createNamespace),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            dependency_update: {
                value: cdktf.booleanToHclTerraform(this._dependencyUpdate),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            description: {
                value: cdktf.stringToHclTerraform(this._description),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            devel: {
                value: cdktf.booleanToHclTerraform(this._devel),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            disable_crd_hooks: {
                value: cdktf.booleanToHclTerraform(this._disableCrdHooks),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            disable_openapi_validation: {
                value: cdktf.booleanToHclTerraform(this._disableOpenapiValidation),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            disable_webhooks: {
                value: cdktf.booleanToHclTerraform(this._disableWebhooks),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            force_update: {
                value: cdktf.booleanToHclTerraform(this._forceUpdate),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            id: {
                value: cdktf.stringToHclTerraform(this._id),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            keyring: {
                value: cdktf.stringToHclTerraform(this._keyring),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            lint: {
                value: cdktf.booleanToHclTerraform(this._lint),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            max_history: {
                value: cdktf.numberToHclTerraform(this._maxHistory),
                isBlock: false,
                type: "simple",
                storageClassType: "number",
            },
            name: {
                value: cdktf.stringToHclTerraform(this._name),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            namespace: {
                value: cdktf.stringToHclTerraform(this._namespace),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            pass_credentials: {
                value: cdktf.booleanToHclTerraform(this._passCredentials),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            recreate_pods: {
                value: cdktf.booleanToHclTerraform(this._recreatePods),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            render_subchart_notes: {
                value: cdktf.booleanToHclTerraform(this._renderSubchartNotes),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            replace: {
                value: cdktf.booleanToHclTerraform(this._replace),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            repository: {
                value: cdktf.stringToHclTerraform(this._repository),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            repository_ca_file: {
                value: cdktf.stringToHclTerraform(this._repositoryCaFile),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            repository_cert_file: {
                value: cdktf.stringToHclTerraform(this._repositoryCertFile),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            repository_key_file: {
                value: cdktf.stringToHclTerraform(this._repositoryKeyFile),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            repository_password: {
                value: cdktf.stringToHclTerraform(this._repositoryPassword),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            repository_username: {
                value: cdktf.stringToHclTerraform(this._repositoryUsername),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            reset_values: {
                value: cdktf.booleanToHclTerraform(this._resetValues),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            reuse_values: {
                value: cdktf.booleanToHclTerraform(this._reuseValues),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            skip_crds: {
                value: cdktf.booleanToHclTerraform(this._skipCrds),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            timeout: {
                value: cdktf.numberToHclTerraform(this._timeout),
                isBlock: false,
                type: "simple",
                storageClassType: "number",
            },
            upgrade_install: {
                value: cdktf.booleanToHclTerraform(this._upgradeInstall),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            values: {
                value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(this._values),
                isBlock: false,
                type: "list",
                storageClassType: "stringList",
            },
            verify: {
                value: cdktf.booleanToHclTerraform(this._verify),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            version: {
                value: cdktf.stringToHclTerraform(this._version),
                isBlock: false,
                type: "simple",
                storageClassType: "string",
            },
            wait: {
                value: cdktf.booleanToHclTerraform(this._wait),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            wait_for_jobs: {
                value: cdktf.booleanToHclTerraform(this._waitForJobs),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            postrender: {
                value: releasePostrenderToHclTerraform(this._postrender.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "ReleasePostrenderList",
            },
            set: {
                value: cdktf.listMapperHcl(releaseSetToHclTerraform, true)(this._set.internalValue),
                isBlock: true,
                type: "set",
                storageClassType: "ReleaseSetList",
            },
            set_list: {
                value: cdktf.listMapperHcl(releaseSetListStructToHclTerraform, true)(this._setList.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "ReleaseSetListStructList",
            },
            set_sensitive: {
                value: cdktf.listMapperHcl(releaseSetSensitiveToHclTerraform, true)(this._setSensitive.internalValue),
                isBlock: true,
                type: "set",
                storageClassType: "ReleaseSetSensitiveList",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
