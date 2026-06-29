// https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim
// generated from terraform resource schema
import * as cdktf from 'cdktf';
export function persistentVolumeClaimMetadataToTerraform(struct) {
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
export function persistentVolumeClaimMetadataToHclTerraform(struct) {
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
export class PersistentVolumeClaimMetadataOutputReference extends cdktf.ComplexObject {
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
export function persistentVolumeClaimSpecResourcesToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        limits: cdktf.hashMapper(cdktf.stringToTerraform)(struct.limits),
        requests: cdktf.hashMapper(cdktf.stringToTerraform)(struct.requests),
    };
}
export function persistentVolumeClaimSpecResourcesToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        limits: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.limits),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        requests: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.requests),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class PersistentVolumeClaimSpecResourcesOutputReference extends cdktf.ComplexObject {
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
        if (this._limits !== undefined) {
            hasAnyValues = true;
            internalValueResult.limits = this._limits;
        }
        if (this._requests !== undefined) {
            hasAnyValues = true;
            internalValueResult.requests = this._requests;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._limits = undefined;
            this._requests = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._limits = value.limits;
            this._requests = value.requests;
        }
    }
    // limits - computed: false, optional: true, required: false
    _limits;
    get limits() {
        return this.getStringMapAttribute('limits');
    }
    set limits(value) {
        this._limits = value;
    }
    resetLimits() {
        this._limits = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get limitsInput() {
        return this._limits;
    }
    // requests - computed: false, optional: true, required: false
    _requests;
    get requests() {
        return this.getStringMapAttribute('requests');
    }
    set requests(value) {
        this._requests = value;
    }
    resetRequests() {
        this._requests = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get requestsInput() {
        return this._requests;
    }
}
export function persistentVolumeClaimSpecSelectorMatchExpressionsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        operator: cdktf.stringToTerraform(struct.operator),
        values: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.values),
    };
}
export function persistentVolumeClaimSpecSelectorMatchExpressionsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        key: {
            value: cdktf.stringToHclTerraform(struct.key),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        operator: {
            value: cdktf.stringToHclTerraform(struct.operator),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        values: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.values),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class PersistentVolumeClaimSpecSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
        if (this._key !== undefined) {
            hasAnyValues = true;
            internalValueResult.key = this._key;
        }
        if (this._operator !== undefined) {
            hasAnyValues = true;
            internalValueResult.operator = this._operator;
        }
        if (this._values !== undefined) {
            hasAnyValues = true;
            internalValueResult.values = this._values;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._key = undefined;
            this._operator = undefined;
            this._values = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._key = value.key;
            this._operator = value.operator;
            this._values = value.values;
        }
    }
    // key - computed: false, optional: true, required: false
    _key;
    get key() {
        return this.getStringAttribute('key');
    }
    set key(value) {
        this._key = value;
    }
    resetKey() {
        this._key = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get keyInput() {
        return this._key;
    }
    // operator - computed: false, optional: true, required: false
    _operator;
    get operator() {
        return this.getStringAttribute('operator');
    }
    set operator(value) {
        this._operator = value;
    }
    resetOperator() {
        this._operator = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get operatorInput() {
        return this._operator;
    }
    // values - computed: false, optional: true, required: false
    _values;
    get values() {
        return cdktf.Fn.tolist(this.getListAttribute('values'));
    }
    set values(value) {
        this._values = value;
    }
    resetValues() {
        this._values = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valuesInput() {
        return this._values;
    }
}
export class PersistentVolumeClaimSpecSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new PersistentVolumeClaimSpecSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function persistentVolumeClaimSpecSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(persistentVolumeClaimSpecSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function persistentVolumeClaimSpecSelectorToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        match_labels: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.matchLabels),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        match_expressions: {
            value: cdktf.listMapperHcl(persistentVolumeClaimSpecSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "PersistentVolumeClaimSpecSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class PersistentVolumeClaimSpecSelectorOutputReference extends cdktf.ComplexObject {
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
        if (this._matchLabels !== undefined) {
            hasAnyValues = true;
            internalValueResult.matchLabels = this._matchLabels;
        }
        if (this._matchExpressions?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.matchExpressions = this._matchExpressions?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._matchLabels = value.matchLabels;
            this._matchExpressions.internalValue = value.matchExpressions;
        }
    }
    // match_labels - computed: false, optional: true, required: false
    _matchLabels;
    get matchLabels() {
        return this.getStringMapAttribute('match_labels');
    }
    set matchLabels(value) {
        this._matchLabels = value;
    }
    resetMatchLabels() {
        this._matchLabels = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get matchLabelsInput() {
        return this._matchLabels;
    }
    // match_expressions - computed: false, optional: true, required: false
    _matchExpressions = new PersistentVolumeClaimSpecSelectorMatchExpressionsList(this, "match_expressions", false);
    get matchExpressions() {
        return this._matchExpressions;
    }
    putMatchExpressions(value) {
        this._matchExpressions.internalValue = value;
    }
    resetMatchExpressions() {
        this._matchExpressions.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get matchExpressionsInput() {
        return this._matchExpressions.internalValue;
    }
}
export function persistentVolumeClaimSpecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        access_modes: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.accessModes),
        storage_class_name: cdktf.stringToTerraform(struct.storageClassName),
        volume_mode: cdktf.stringToTerraform(struct.volumeMode),
        volume_name: cdktf.stringToTerraform(struct.volumeName),
        resources: persistentVolumeClaimSpecResourcesToTerraform(struct.resources),
        selector: persistentVolumeClaimSpecSelectorToTerraform(struct.selector),
    };
}
export function persistentVolumeClaimSpecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        access_modes: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.accessModes),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        storage_class_name: {
            value: cdktf.stringToHclTerraform(struct.storageClassName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        volume_mode: {
            value: cdktf.stringToHclTerraform(struct.volumeMode),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        volume_name: {
            value: cdktf.stringToHclTerraform(struct.volumeName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        resources: {
            value: persistentVolumeClaimSpecResourcesToHclTerraform(struct.resources),
            isBlock: true,
            type: "list",
            storageClassType: "PersistentVolumeClaimSpecResourcesList",
        },
        selector: {
            value: persistentVolumeClaimSpecSelectorToHclTerraform(struct.selector),
            isBlock: true,
            type: "list",
            storageClassType: "PersistentVolumeClaimSpecSelectorList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class PersistentVolumeClaimSpecOutputReference extends cdktf.ComplexObject {
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
        if (this._accessModes !== undefined) {
            hasAnyValues = true;
            internalValueResult.accessModes = this._accessModes;
        }
        if (this._storageClassName !== undefined) {
            hasAnyValues = true;
            internalValueResult.storageClassName = this._storageClassName;
        }
        if (this._volumeMode !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeMode = this._volumeMode;
        }
        if (this._volumeName !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeName = this._volumeName;
        }
        if (this._resources?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.resources = this._resources?.internalValue;
        }
        if (this._selector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.selector = this._selector?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._accessModes = undefined;
            this._storageClassName = undefined;
            this._volumeMode = undefined;
            this._volumeName = undefined;
            this._resources.internalValue = undefined;
            this._selector.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._accessModes = value.accessModes;
            this._storageClassName = value.storageClassName;
            this._volumeMode = value.volumeMode;
            this._volumeName = value.volumeName;
            this._resources.internalValue = value.resources;
            this._selector.internalValue = value.selector;
        }
    }
    // access_modes - computed: false, optional: false, required: true
    _accessModes;
    get accessModes() {
        return cdktf.Fn.tolist(this.getListAttribute('access_modes'));
    }
    set accessModes(value) {
        this._accessModes = value;
    }
    // Temporarily expose input value. Use with caution.
    get accessModesInput() {
        return this._accessModes;
    }
    // storage_class_name - computed: true, optional: true, required: false
    _storageClassName;
    get storageClassName() {
        return this.getStringAttribute('storage_class_name');
    }
    set storageClassName(value) {
        this._storageClassName = value;
    }
    resetStorageClassName() {
        this._storageClassName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get storageClassNameInput() {
        return this._storageClassName;
    }
    // volume_mode - computed: true, optional: true, required: false
    _volumeMode;
    get volumeMode() {
        return this.getStringAttribute('volume_mode');
    }
    set volumeMode(value) {
        this._volumeMode = value;
    }
    resetVolumeMode() {
        this._volumeMode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get volumeModeInput() {
        return this._volumeMode;
    }
    // volume_name - computed: true, optional: true, required: false
    _volumeName;
    get volumeName() {
        return this.getStringAttribute('volume_name');
    }
    set volumeName(value) {
        this._volumeName = value;
    }
    resetVolumeName() {
        this._volumeName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get volumeNameInput() {
        return this._volumeName;
    }
    // resources - computed: false, optional: false, required: true
    _resources = new PersistentVolumeClaimSpecResourcesOutputReference(this, "resources");
    get resources() {
        return this._resources;
    }
    putResources(value) {
        this._resources.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get resourcesInput() {
        return this._resources.internalValue;
    }
    // selector - computed: false, optional: true, required: false
    _selector = new PersistentVolumeClaimSpecSelectorOutputReference(this, "selector");
    get selector() {
        return this._selector;
    }
    putSelector(value) {
        this._selector.internalValue = value;
    }
    resetSelector() {
        this._selector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get selectorInput() {
        return this._selector.internalValue;
    }
}
export function persistentVolumeClaimTimeoutsToTerraform(struct) {
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
export function persistentVolumeClaimTimeoutsToHclTerraform(struct) {
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
export class PersistentVolumeClaimTimeoutsOutputReference extends cdktf.ComplexObject {
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
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim kubernetes_persistent_volume_claim}
*/
export class PersistentVolumeClaim extends cdktf.TerraformResource {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "kubernetes_persistent_volume_claim";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a PersistentVolumeClaim resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the PersistentVolumeClaim to import
    * @param importFromId The id of the existing PersistentVolumeClaim that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the PersistentVolumeClaim to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "kubernetes_persistent_volume_claim", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/persistent_volume_claim kubernetes_persistent_volume_claim} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options PersistentVolumeClaimConfig
    */
    constructor(scope, id, config) {
        super(scope, id, {
            terraformResourceType: 'kubernetes_persistent_volume_claim',
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
        this._waitUntilBound = config.waitUntilBound;
        this._metadata.internalValue = config.metadata;
        this._spec.internalValue = config.spec;
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
    // wait_until_bound - computed: false, optional: true, required: false
    _waitUntilBound;
    get waitUntilBound() {
        return this.getBooleanAttribute('wait_until_bound');
    }
    set waitUntilBound(value) {
        this._waitUntilBound = value;
    }
    resetWaitUntilBound() {
        this._waitUntilBound = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get waitUntilBoundInput() {
        return this._waitUntilBound;
    }
    // metadata - computed: false, optional: false, required: true
    _metadata = new PersistentVolumeClaimMetadataOutputReference(this, "metadata");
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
    // spec - computed: false, optional: false, required: true
    _spec = new PersistentVolumeClaimSpecOutputReference(this, "spec");
    get spec() {
        return this._spec;
    }
    putSpec(value) {
        this._spec.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get specInput() {
        return this._spec.internalValue;
    }
    // timeouts - computed: false, optional: true, required: false
    _timeouts = new PersistentVolumeClaimTimeoutsOutputReference(this, "timeouts");
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
            wait_until_bound: cdktf.booleanToTerraform(this._waitUntilBound),
            metadata: persistentVolumeClaimMetadataToTerraform(this._metadata.internalValue),
            spec: persistentVolumeClaimSpecToTerraform(this._spec.internalValue),
            timeouts: persistentVolumeClaimTimeoutsToTerraform(this._timeouts.internalValue),
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
            wait_until_bound: {
                value: cdktf.booleanToHclTerraform(this._waitUntilBound),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            metadata: {
                value: persistentVolumeClaimMetadataToHclTerraform(this._metadata.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "PersistentVolumeClaimMetadataList",
            },
            spec: {
                value: persistentVolumeClaimSpecToHclTerraform(this._spec.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "PersistentVolumeClaimSpecList",
            },
            timeouts: {
                value: persistentVolumeClaimTimeoutsToHclTerraform(this._timeouts.internalValue),
                isBlock: true,
                type: "struct",
                storageClassType: "PersistentVolumeClaimTimeouts",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
