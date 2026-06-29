import * as cdktf from 'cdktf';
export function deploymentMetadataToTerraform(struct) {
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
export function deploymentMetadataToHclTerraform(struct) {
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
export class DeploymentMetadataOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecSelectorOutputReference extends cdktf.ComplexObject {
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
    _matchExpressions = new DeploymentSpecSelectorMatchExpressionsList(this, "match_expressions", false);
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
export function deploymentSpecStrategyRollingUpdateToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        max_surge: cdktf.stringToTerraform(struct.maxSurge),
        max_unavailable: cdktf.stringToTerraform(struct.maxUnavailable),
    };
}
export function deploymentSpecStrategyRollingUpdateToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        max_surge: {
            value: cdktf.stringToHclTerraform(struct.maxSurge),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        max_unavailable: {
            value: cdktf.stringToHclTerraform(struct.maxUnavailable),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecStrategyRollingUpdateOutputReference extends cdktf.ComplexObject {
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
        if (this._maxSurge !== undefined) {
            hasAnyValues = true;
            internalValueResult.maxSurge = this._maxSurge;
        }
        if (this._maxUnavailable !== undefined) {
            hasAnyValues = true;
            internalValueResult.maxUnavailable = this._maxUnavailable;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._maxSurge = undefined;
            this._maxUnavailable = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._maxSurge = value.maxSurge;
            this._maxUnavailable = value.maxUnavailable;
        }
    }
    // max_surge - computed: false, optional: true, required: false
    _maxSurge;
    get maxSurge() {
        return this.getStringAttribute('max_surge');
    }
    set maxSurge(value) {
        this._maxSurge = value;
    }
    resetMaxSurge() {
        this._maxSurge = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get maxSurgeInput() {
        return this._maxSurge;
    }
    // max_unavailable - computed: false, optional: true, required: false
    _maxUnavailable;
    get maxUnavailable() {
        return this.getStringAttribute('max_unavailable');
    }
    set maxUnavailable(value) {
        this._maxUnavailable = value;
    }
    resetMaxUnavailable() {
        this._maxUnavailable = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get maxUnavailableInput() {
        return this._maxUnavailable;
    }
}
export function deploymentSpecStrategyToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        type: cdktf.stringToTerraform(struct.type),
        rolling_update: deploymentSpecStrategyRollingUpdateToTerraform(struct.rollingUpdate),
    };
}
export function deploymentSpecStrategyToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        type: {
            value: cdktf.stringToHclTerraform(struct.type),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        rolling_update: {
            value: deploymentSpecStrategyRollingUpdateToHclTerraform(struct.rollingUpdate),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecStrategyRollingUpdateList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecStrategyOutputReference extends cdktf.ComplexObject {
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
        if (this._type !== undefined) {
            hasAnyValues = true;
            internalValueResult.type = this._type;
        }
        if (this._rollingUpdate?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.rollingUpdate = this._rollingUpdate?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._type = undefined;
            this._rollingUpdate.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._type = value.type;
            this._rollingUpdate.internalValue = value.rollingUpdate;
        }
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
    // rolling_update - computed: false, optional: true, required: false
    _rollingUpdate = new DeploymentSpecStrategyRollingUpdateOutputReference(this, "rolling_update");
    get rollingUpdate() {
        return this._rollingUpdate;
    }
    putRollingUpdate(value) {
        this._rollingUpdate.internalValue = value;
    }
    resetRollingUpdate() {
        this._rollingUpdate.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get rollingUpdateInput() {
        return this._rollingUpdate.internalValue;
    }
}
export function deploymentSpecTemplateMetadataToTerraform(struct) {
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
export function deploymentSpecTemplateMetadataToHclTerraform(struct) {
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
export class DeploymentSpecTemplateMetadataOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsOutputReference extends cdktf.ComplexObject {
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
    // key - computed: false, optional: false, required: true
    _key;
    get key() {
        return this.getStringAttribute('key');
    }
    set key(value) {
        this._key = value;
    }
    // Temporarily expose input value. Use with caution.
    get keyInput() {
        return this._key;
    }
    // operator - computed: false, optional: false, required: true
    _operator;
    get operator() {
        return this.getStringAttribute('operator');
    }
    set operator(value) {
        this._operator = value;
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsToTerraform, true)(struct.matchExpressions),
        match_fields: cdktf.listMapper(deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsToTerraform, true)(struct.matchFields),
    };
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        match_expressions: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsList",
        },
        match_fields: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsToHclTerraform, true)(struct.matchFields),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceOutputReference extends cdktf.ComplexObject {
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
        if (this._matchExpressions?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.matchExpressions = this._matchExpressions?.internalValue;
        }
        if (this._matchFields?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.matchFields = this._matchFields?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._matchExpressions.internalValue = undefined;
            this._matchFields.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._matchExpressions.internalValue = value.matchExpressions;
            this._matchFields.internalValue = value.matchFields;
        }
    }
    // match_expressions - computed: false, optional: true, required: false
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchExpressionsList(this, "match_expressions", false);
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
    // match_fields - computed: false, optional: true, required: false
    _matchFields = new DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceMatchFieldsList(this, "match_fields", false);
    get matchFields() {
        return this._matchFields;
    }
    putMatchFields(value) {
        this._matchFields.internalValue = value;
    }
    resetMatchFields() {
        this._matchFields.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get matchFieldsInput() {
        return this._matchFields.internalValue;
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        weight: cdktf.numberToTerraform(struct.weight),
        preference: deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceToTerraform(struct.preference),
    };
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        weight: {
            value: cdktf.numberToHclTerraform(struct.weight),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        preference: {
            value: deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceToHclTerraform(struct.preference),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionOutputReference extends cdktf.ComplexObject {
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
        if (this._weight !== undefined) {
            hasAnyValues = true;
            internalValueResult.weight = this._weight;
        }
        if (this._preference?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.preference = this._preference?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._weight = undefined;
            this._preference.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._weight = value.weight;
            this._preference.internalValue = value.preference;
        }
    }
    // weight - computed: false, optional: false, required: true
    _weight;
    get weight() {
        return this.getNumberAttribute('weight');
    }
    set weight(value) {
        this._weight = value;
    }
    // Temporarily expose input value. Use with caution.
    get weightInput() {
        return this._weight;
    }
    // preference - computed: false, optional: false, required: true
    _preference = new DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionPreferenceOutputReference(this, "preference");
    get preference() {
        return this._preference;
    }
    putPreference(value) {
        this._preference.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get preferenceInput() {
        return this._preference.internalValue;
    }
}
export class DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsOutputReference extends cdktf.ComplexObject {
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
    // key - computed: false, optional: false, required: true
    _key;
    get key() {
        return this.getStringAttribute('key');
    }
    set key(value) {
        this._key = value;
    }
    // Temporarily expose input value. Use with caution.
    get keyInput() {
        return this._key;
    }
    // operator - computed: false, optional: false, required: true
    _operator;
    get operator() {
        return this.getStringAttribute('operator');
    }
    set operator(value) {
        this._operator = value;
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
export class DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsToTerraform, true)(struct.matchExpressions),
        match_fields: cdktf.listMapper(deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsToTerraform, true)(struct.matchFields),
    };
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        match_expressions: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsList",
        },
        match_fields: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsToHclTerraform, true)(struct.matchFields),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermOutputReference extends cdktf.ComplexObject {
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
        if (this._matchExpressions?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.matchExpressions = this._matchExpressions?.internalValue;
        }
        if (this._matchFields?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.matchFields = this._matchFields?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._matchExpressions.internalValue = undefined;
            this._matchFields.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._matchExpressions.internalValue = value.matchExpressions;
            this._matchFields.internalValue = value.matchFields;
        }
    }
    // match_expressions - computed: false, optional: true, required: false
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchExpressionsList(this, "match_expressions", false);
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
    // match_fields - computed: false, optional: true, required: false
    _matchFields = new DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermMatchFieldsList(this, "match_fields", false);
    get matchFields() {
        return this._matchFields;
    }
    putMatchFields(value) {
        this._matchFields.internalValue = value;
    }
    resetMatchFields() {
        this._matchFields.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get matchFieldsInput() {
        return this._matchFields.internalValue;
    }
}
export class DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        node_selector_term: cdktf.listMapper(deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermToTerraform, true)(struct.nodeSelectorTerm),
    };
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        node_selector_term: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermToHclTerraform, true)(struct.nodeSelectorTerm),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionOutputReference extends cdktf.ComplexObject {
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
        if (this._nodeSelectorTerm?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodeSelectorTerm = this._nodeSelectorTerm?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._nodeSelectorTerm.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._nodeSelectorTerm.internalValue = value.nodeSelectorTerm;
        }
    }
    // node_selector_term - computed: false, optional: true, required: false
    _nodeSelectorTerm = new DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionNodeSelectorTermList(this, "node_selector_term", false);
    get nodeSelectorTerm() {
        return this._nodeSelectorTerm;
    }
    putNodeSelectorTerm(value) {
        this._nodeSelectorTerm.internalValue = value;
    }
    resetNodeSelectorTerm() {
        this._nodeSelectorTerm.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodeSelectorTermInput() {
        return this._nodeSelectorTerm.internalValue;
    }
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        preferred_during_scheduling_ignored_during_execution: cdktf.listMapper(deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionToTerraform, true)(struct.preferredDuringSchedulingIgnoredDuringExecution),
        required_during_scheduling_ignored_during_execution: deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionToTerraform(struct.requiredDuringSchedulingIgnoredDuringExecution),
    };
}
export function deploymentSpecTemplateSpecAffinityNodeAffinityToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        preferred_during_scheduling_ignored_during_execution: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionToHclTerraform, true)(struct.preferredDuringSchedulingIgnoredDuringExecution),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionList",
        },
        required_during_scheduling_ignored_during_execution: {
            value: deploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionToHclTerraform(struct.requiredDuringSchedulingIgnoredDuringExecution),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityNodeAffinityOutputReference extends cdktf.ComplexObject {
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
        if (this._preferredDuringSchedulingIgnoredDuringExecution?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.preferredDuringSchedulingIgnoredDuringExecution = this._preferredDuringSchedulingIgnoredDuringExecution?.internalValue;
        }
        if (this._requiredDuringSchedulingIgnoredDuringExecution?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.requiredDuringSchedulingIgnoredDuringExecution = this._requiredDuringSchedulingIgnoredDuringExecution?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
            this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = value.preferredDuringSchedulingIgnoredDuringExecution;
            this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = value.requiredDuringSchedulingIgnoredDuringExecution;
        }
    }
    // preferred_during_scheduling_ignored_during_execution - computed: false, optional: true, required: false
    _preferredDuringSchedulingIgnoredDuringExecution = new DeploymentSpecTemplateSpecAffinityNodeAffinityPreferredDuringSchedulingIgnoredDuringExecutionList(this, "preferred_during_scheduling_ignored_during_execution", false);
    get preferredDuringSchedulingIgnoredDuringExecution() {
        return this._preferredDuringSchedulingIgnoredDuringExecution;
    }
    putPreferredDuringSchedulingIgnoredDuringExecution(value) {
        this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = value;
    }
    resetPreferredDuringSchedulingIgnoredDuringExecution() {
        this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get preferredDuringSchedulingIgnoredDuringExecutionInput() {
        return this._preferredDuringSchedulingIgnoredDuringExecution.internalValue;
    }
    // required_during_scheduling_ignored_during_execution - computed: false, optional: true, required: false
    _requiredDuringSchedulingIgnoredDuringExecution = new DeploymentSpecTemplateSpecAffinityNodeAffinityRequiredDuringSchedulingIgnoredDuringExecutionOutputReference(this, "required_during_scheduling_ignored_during_execution");
    get requiredDuringSchedulingIgnoredDuringExecution() {
        return this._requiredDuringSchedulingIgnoredDuringExecution;
    }
    putRequiredDuringSchedulingIgnoredDuringExecution(value) {
        this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = value;
    }
    resetRequiredDuringSchedulingIgnoredDuringExecution() {
        this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get requiredDuringSchedulingIgnoredDuringExecutionInput() {
        return this._requiredDuringSchedulingIgnoredDuringExecution.internalValue;
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        namespaces: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.namespaces),
        topology_key: cdktf.stringToTerraform(struct.topologyKey),
        label_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToTerraform, true)(struct.labelSelector),
        namespace_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToTerraform, true)(struct.namespaceSelector),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        namespaces: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.namespaces),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        topology_key: {
            value: cdktf.stringToHclTerraform(struct.topologyKey),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        label_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToHclTerraform, true)(struct.labelSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorList",
        },
        namespace_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToHclTerraform, true)(struct.namespaceSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermOutputReference extends cdktf.ComplexObject {
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
        if (this._namespaces !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaces = this._namespaces;
        }
        if (this._topologyKey !== undefined) {
            hasAnyValues = true;
            internalValueResult.topologyKey = this._topologyKey;
        }
        if (this._labelSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.labelSelector = this._labelSelector?.internalValue;
        }
        if (this._namespaceSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaceSelector = this._namespaceSelector?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._namespaces = undefined;
            this._topologyKey = undefined;
            this._labelSelector.internalValue = undefined;
            this._namespaceSelector.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._namespaces = value.namespaces;
            this._topologyKey = value.topologyKey;
            this._labelSelector.internalValue = value.labelSelector;
            this._namespaceSelector.internalValue = value.namespaceSelector;
        }
    }
    // namespaces - computed: false, optional: true, required: false
    _namespaces;
    get namespaces() {
        return cdktf.Fn.tolist(this.getListAttribute('namespaces'));
    }
    set namespaces(value) {
        this._namespaces = value;
    }
    resetNamespaces() {
        this._namespaces = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespacesInput() {
        return this._namespaces;
    }
    // topology_key - computed: false, optional: false, required: true
    _topologyKey;
    get topologyKey() {
        return this.getStringAttribute('topology_key');
    }
    set topologyKey(value) {
        this._topologyKey = value;
    }
    // Temporarily expose input value. Use with caution.
    get topologyKeyInput() {
        return this._topologyKey;
    }
    // label_selector - computed: false, optional: true, required: false
    _labelSelector = new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorList(this, "label_selector", false);
    get labelSelector() {
        return this._labelSelector;
    }
    putLabelSelector(value) {
        this._labelSelector.internalValue = value;
    }
    resetLabelSelector() {
        this._labelSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get labelSelectorInput() {
        return this._labelSelector.internalValue;
    }
    // namespace_selector - computed: false, optional: true, required: false
    _namespaceSelector = new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorList(this, "namespace_selector", false);
    get namespaceSelector() {
        return this._namespaceSelector;
    }
    putNamespaceSelector(value) {
        this._namespaceSelector.internalValue = value;
    }
    resetNamespaceSelector() {
        this._namespaceSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespaceSelectorInput() {
        return this._namespaceSelector.internalValue;
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        weight: cdktf.numberToTerraform(struct.weight),
        pod_affinity_term: deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToTerraform(struct.podAffinityTerm),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        weight: {
            value: cdktf.numberToHclTerraform(struct.weight),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        pod_affinity_term: {
            value: deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToHclTerraform(struct.podAffinityTerm),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionOutputReference extends cdktf.ComplexObject {
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
        if (this._weight !== undefined) {
            hasAnyValues = true;
            internalValueResult.weight = this._weight;
        }
        if (this._podAffinityTerm?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.podAffinityTerm = this._podAffinityTerm?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._weight = undefined;
            this._podAffinityTerm.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._weight = value.weight;
            this._podAffinityTerm.internalValue = value.podAffinityTerm;
        }
    }
    // weight - computed: false, optional: false, required: true
    _weight;
    get weight() {
        return this.getNumberAttribute('weight');
    }
    set weight(value) {
        this._weight = value;
    }
    // Temporarily expose input value. Use with caution.
    get weightInput() {
        return this._weight;
    }
    // pod_affinity_term - computed: false, optional: false, required: true
    _podAffinityTerm = new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermOutputReference(this, "pod_affinity_term");
    get podAffinityTerm() {
        return this._podAffinityTerm;
    }
    putPodAffinityTerm(value) {
        this._podAffinityTerm.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get podAffinityTermInput() {
        return this._podAffinityTerm.internalValue;
    }
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        namespaces: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.namespaces),
        topology_key: cdktf.stringToTerraform(struct.topologyKey),
        label_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToTerraform, true)(struct.labelSelector),
        namespace_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToTerraform, true)(struct.namespaceSelector),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        namespaces: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.namespaces),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        topology_key: {
            value: cdktf.stringToHclTerraform(struct.topologyKey),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        label_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToHclTerraform, true)(struct.labelSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorList",
        },
        namespace_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToHclTerraform, true)(struct.namespaceSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionOutputReference extends cdktf.ComplexObject {
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
        if (this._namespaces !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaces = this._namespaces;
        }
        if (this._topologyKey !== undefined) {
            hasAnyValues = true;
            internalValueResult.topologyKey = this._topologyKey;
        }
        if (this._labelSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.labelSelector = this._labelSelector?.internalValue;
        }
        if (this._namespaceSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaceSelector = this._namespaceSelector?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._namespaces = undefined;
            this._topologyKey = undefined;
            this._labelSelector.internalValue = undefined;
            this._namespaceSelector.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._namespaces = value.namespaces;
            this._topologyKey = value.topologyKey;
            this._labelSelector.internalValue = value.labelSelector;
            this._namespaceSelector.internalValue = value.namespaceSelector;
        }
    }
    // namespaces - computed: false, optional: true, required: false
    _namespaces;
    get namespaces() {
        return cdktf.Fn.tolist(this.getListAttribute('namespaces'));
    }
    set namespaces(value) {
        this._namespaces = value;
    }
    resetNamespaces() {
        this._namespaces = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespacesInput() {
        return this._namespaces;
    }
    // topology_key - computed: false, optional: false, required: true
    _topologyKey;
    get topologyKey() {
        return this.getStringAttribute('topology_key');
    }
    set topologyKey(value) {
        this._topologyKey = value;
    }
    // Temporarily expose input value. Use with caution.
    get topologyKeyInput() {
        return this._topologyKey;
    }
    // label_selector - computed: false, optional: true, required: false
    _labelSelector = new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorList(this, "label_selector", false);
    get labelSelector() {
        return this._labelSelector;
    }
    putLabelSelector(value) {
        this._labelSelector.internalValue = value;
    }
    resetLabelSelector() {
        this._labelSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get labelSelectorInput() {
        return this._labelSelector.internalValue;
    }
    // namespace_selector - computed: false, optional: true, required: false
    _namespaceSelector = new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorList(this, "namespace_selector", false);
    get namespaceSelector() {
        return this._namespaceSelector;
    }
    putNamespaceSelector(value) {
        this._namespaceSelector.internalValue = value;
    }
    resetNamespaceSelector() {
        this._namespaceSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespaceSelectorInput() {
        return this._namespaceSelector.internalValue;
    }
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAffinityToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        preferred_during_scheduling_ignored_during_execution: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionToTerraform, true)(struct.preferredDuringSchedulingIgnoredDuringExecution),
        required_during_scheduling_ignored_during_execution: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionToTerraform, true)(struct.requiredDuringSchedulingIgnoredDuringExecution),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAffinityToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        preferred_during_scheduling_ignored_during_execution: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionToHclTerraform, true)(struct.preferredDuringSchedulingIgnoredDuringExecution),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionList",
        },
        required_during_scheduling_ignored_during_execution: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionToHclTerraform, true)(struct.requiredDuringSchedulingIgnoredDuringExecution),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAffinityOutputReference extends cdktf.ComplexObject {
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
        if (this._preferredDuringSchedulingIgnoredDuringExecution?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.preferredDuringSchedulingIgnoredDuringExecution = this._preferredDuringSchedulingIgnoredDuringExecution?.internalValue;
        }
        if (this._requiredDuringSchedulingIgnoredDuringExecution?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.requiredDuringSchedulingIgnoredDuringExecution = this._requiredDuringSchedulingIgnoredDuringExecution?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
            this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = value.preferredDuringSchedulingIgnoredDuringExecution;
            this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = value.requiredDuringSchedulingIgnoredDuringExecution;
        }
    }
    // preferred_during_scheduling_ignored_during_execution - computed: false, optional: true, required: false
    _preferredDuringSchedulingIgnoredDuringExecution = new DeploymentSpecTemplateSpecAffinityPodAffinityPreferredDuringSchedulingIgnoredDuringExecutionList(this, "preferred_during_scheduling_ignored_during_execution", false);
    get preferredDuringSchedulingIgnoredDuringExecution() {
        return this._preferredDuringSchedulingIgnoredDuringExecution;
    }
    putPreferredDuringSchedulingIgnoredDuringExecution(value) {
        this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = value;
    }
    resetPreferredDuringSchedulingIgnoredDuringExecution() {
        this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get preferredDuringSchedulingIgnoredDuringExecutionInput() {
        return this._preferredDuringSchedulingIgnoredDuringExecution.internalValue;
    }
    // required_during_scheduling_ignored_during_execution - computed: false, optional: true, required: false
    _requiredDuringSchedulingIgnoredDuringExecution = new DeploymentSpecTemplateSpecAffinityPodAffinityRequiredDuringSchedulingIgnoredDuringExecutionList(this, "required_during_scheduling_ignored_during_execution", false);
    get requiredDuringSchedulingIgnoredDuringExecution() {
        return this._requiredDuringSchedulingIgnoredDuringExecution;
    }
    putRequiredDuringSchedulingIgnoredDuringExecution(value) {
        this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = value;
    }
    resetRequiredDuringSchedulingIgnoredDuringExecution() {
        this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get requiredDuringSchedulingIgnoredDuringExecutionInput() {
        return this._requiredDuringSchedulingIgnoredDuringExecution.internalValue;
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        namespaces: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.namespaces),
        topology_key: cdktf.stringToTerraform(struct.topologyKey),
        label_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToTerraform, true)(struct.labelSelector),
        namespace_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToTerraform, true)(struct.namespaceSelector),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        namespaces: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.namespaces),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        topology_key: {
            value: cdktf.stringToHclTerraform(struct.topologyKey),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        label_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorToHclTerraform, true)(struct.labelSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorList",
        },
        namespace_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorToHclTerraform, true)(struct.namespaceSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermOutputReference extends cdktf.ComplexObject {
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
        if (this._namespaces !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaces = this._namespaces;
        }
        if (this._topologyKey !== undefined) {
            hasAnyValues = true;
            internalValueResult.topologyKey = this._topologyKey;
        }
        if (this._labelSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.labelSelector = this._labelSelector?.internalValue;
        }
        if (this._namespaceSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaceSelector = this._namespaceSelector?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._namespaces = undefined;
            this._topologyKey = undefined;
            this._labelSelector.internalValue = undefined;
            this._namespaceSelector.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._namespaces = value.namespaces;
            this._topologyKey = value.topologyKey;
            this._labelSelector.internalValue = value.labelSelector;
            this._namespaceSelector.internalValue = value.namespaceSelector;
        }
    }
    // namespaces - computed: false, optional: true, required: false
    _namespaces;
    get namespaces() {
        return cdktf.Fn.tolist(this.getListAttribute('namespaces'));
    }
    set namespaces(value) {
        this._namespaces = value;
    }
    resetNamespaces() {
        this._namespaces = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespacesInput() {
        return this._namespaces;
    }
    // topology_key - computed: false, optional: false, required: true
    _topologyKey;
    get topologyKey() {
        return this.getStringAttribute('topology_key');
    }
    set topologyKey(value) {
        this._topologyKey = value;
    }
    // Temporarily expose input value. Use with caution.
    get topologyKeyInput() {
        return this._topologyKey;
    }
    // label_selector - computed: false, optional: true, required: false
    _labelSelector = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelectorList(this, "label_selector", false);
    get labelSelector() {
        return this._labelSelector;
    }
    putLabelSelector(value) {
        this._labelSelector.internalValue = value;
    }
    resetLabelSelector() {
        this._labelSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get labelSelectorInput() {
        return this._labelSelector.internalValue;
    }
    // namespace_selector - computed: false, optional: true, required: false
    _namespaceSelector = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermNamespaceSelectorList(this, "namespace_selector", false);
    get namespaceSelector() {
        return this._namespaceSelector;
    }
    putNamespaceSelector(value) {
        this._namespaceSelector.internalValue = value;
    }
    resetNamespaceSelector() {
        this._namespaceSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespaceSelectorInput() {
        return this._namespaceSelector.internalValue;
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        weight: cdktf.numberToTerraform(struct.weight),
        pod_affinity_term: deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToTerraform(struct.podAffinityTerm),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        weight: {
            value: cdktf.numberToHclTerraform(struct.weight),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        pod_affinity_term: {
            value: deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermToHclTerraform(struct.podAffinityTerm),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionOutputReference extends cdktf.ComplexObject {
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
        if (this._weight !== undefined) {
            hasAnyValues = true;
            internalValueResult.weight = this._weight;
        }
        if (this._podAffinityTerm?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.podAffinityTerm = this._podAffinityTerm?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._weight = undefined;
            this._podAffinityTerm.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._weight = value.weight;
            this._podAffinityTerm.internalValue = value.podAffinityTerm;
        }
    }
    // weight - computed: false, optional: false, required: true
    _weight;
    get weight() {
        return this.getNumberAttribute('weight');
    }
    set weight(value) {
        this._weight = value;
    }
    // Temporarily expose input value. Use with caution.
    get weightInput() {
        return this._weight;
    }
    // pod_affinity_term - computed: false, optional: false, required: true
    _podAffinityTerm = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermOutputReference(this, "pod_affinity_term");
    get podAffinityTerm() {
        return this._podAffinityTerm;
    }
    putPodAffinityTerm(value) {
        this._podAffinityTerm.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get podAffinityTermInput() {
        return this._podAffinityTerm.internalValue;
    }
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorOutputReference extends cdktf.ComplexObject {
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
            this.resolvableValue = undefined;
            this._matchLabels = undefined;
            this._matchExpressions.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
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
    _matchExpressions = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        namespaces: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.namespaces),
        topology_key: cdktf.stringToTerraform(struct.topologyKey),
        label_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToTerraform, true)(struct.labelSelector),
        namespace_selector: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToTerraform, true)(struct.namespaceSelector),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        namespaces: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.namespaces),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        topology_key: {
            value: cdktf.stringToHclTerraform(struct.topologyKey),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        label_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorToHclTerraform, true)(struct.labelSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorList",
        },
        namespace_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorToHclTerraform, true)(struct.namespaceSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionOutputReference extends cdktf.ComplexObject {
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
        if (this._namespaces !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaces = this._namespaces;
        }
        if (this._topologyKey !== undefined) {
            hasAnyValues = true;
            internalValueResult.topologyKey = this._topologyKey;
        }
        if (this._labelSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.labelSelector = this._labelSelector?.internalValue;
        }
        if (this._namespaceSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespaceSelector = this._namespaceSelector?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._namespaces = undefined;
            this._topologyKey = undefined;
            this._labelSelector.internalValue = undefined;
            this._namespaceSelector.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._namespaces = value.namespaces;
            this._topologyKey = value.topologyKey;
            this._labelSelector.internalValue = value.labelSelector;
            this._namespaceSelector.internalValue = value.namespaceSelector;
        }
    }
    // namespaces - computed: false, optional: true, required: false
    _namespaces;
    get namespaces() {
        return cdktf.Fn.tolist(this.getListAttribute('namespaces'));
    }
    set namespaces(value) {
        this._namespaces = value;
    }
    resetNamespaces() {
        this._namespaces = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespacesInput() {
        return this._namespaces;
    }
    // topology_key - computed: false, optional: false, required: true
    _topologyKey;
    get topologyKey() {
        return this.getStringAttribute('topology_key');
    }
    set topologyKey(value) {
        this._topologyKey = value;
    }
    // Temporarily expose input value. Use with caution.
    get topologyKeyInput() {
        return this._topologyKey;
    }
    // label_selector - computed: false, optional: true, required: false
    _labelSelector = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionLabelSelectorList(this, "label_selector", false);
    get labelSelector() {
        return this._labelSelector;
    }
    putLabelSelector(value) {
        this._labelSelector.internalValue = value;
    }
    resetLabelSelector() {
        this._labelSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get labelSelectorInput() {
        return this._labelSelector.internalValue;
    }
    // namespace_selector - computed: false, optional: true, required: false
    _namespaceSelector = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionNamespaceSelectorList(this, "namespace_selector", false);
    get namespaceSelector() {
        return this._namespaceSelector;
    }
    putNamespaceSelector(value) {
        this._namespaceSelector.internalValue = value;
    }
    resetNamespaceSelector() {
        this._namespaceSelector.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get namespaceSelectorInput() {
        return this._namespaceSelector.internalValue;
    }
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        preferred_during_scheduling_ignored_during_execution: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionToTerraform, true)(struct.preferredDuringSchedulingIgnoredDuringExecution),
        required_during_scheduling_ignored_during_execution: cdktf.listMapper(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionToTerraform, true)(struct.requiredDuringSchedulingIgnoredDuringExecution),
    };
}
export function deploymentSpecTemplateSpecAffinityPodAntiAffinityToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        preferred_during_scheduling_ignored_during_execution: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionToHclTerraform, true)(struct.preferredDuringSchedulingIgnoredDuringExecution),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionList",
        },
        required_during_scheduling_ignored_during_execution: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionToHclTerraform, true)(struct.requiredDuringSchedulingIgnoredDuringExecution),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityPodAntiAffinityOutputReference extends cdktf.ComplexObject {
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
        if (this._preferredDuringSchedulingIgnoredDuringExecution?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.preferredDuringSchedulingIgnoredDuringExecution = this._preferredDuringSchedulingIgnoredDuringExecution?.internalValue;
        }
        if (this._requiredDuringSchedulingIgnoredDuringExecution?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.requiredDuringSchedulingIgnoredDuringExecution = this._requiredDuringSchedulingIgnoredDuringExecution?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
            this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = value.preferredDuringSchedulingIgnoredDuringExecution;
            this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = value.requiredDuringSchedulingIgnoredDuringExecution;
        }
    }
    // preferred_during_scheduling_ignored_during_execution - computed: false, optional: true, required: false
    _preferredDuringSchedulingIgnoredDuringExecution = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionList(this, "preferred_during_scheduling_ignored_during_execution", false);
    get preferredDuringSchedulingIgnoredDuringExecution() {
        return this._preferredDuringSchedulingIgnoredDuringExecution;
    }
    putPreferredDuringSchedulingIgnoredDuringExecution(value) {
        this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = value;
    }
    resetPreferredDuringSchedulingIgnoredDuringExecution() {
        this._preferredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get preferredDuringSchedulingIgnoredDuringExecutionInput() {
        return this._preferredDuringSchedulingIgnoredDuringExecution.internalValue;
    }
    // required_during_scheduling_ignored_during_execution - computed: false, optional: true, required: false
    _requiredDuringSchedulingIgnoredDuringExecution = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityRequiredDuringSchedulingIgnoredDuringExecutionList(this, "required_during_scheduling_ignored_during_execution", false);
    get requiredDuringSchedulingIgnoredDuringExecution() {
        return this._requiredDuringSchedulingIgnoredDuringExecution;
    }
    putRequiredDuringSchedulingIgnoredDuringExecution(value) {
        this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = value;
    }
    resetRequiredDuringSchedulingIgnoredDuringExecution() {
        this._requiredDuringSchedulingIgnoredDuringExecution.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get requiredDuringSchedulingIgnoredDuringExecutionInput() {
        return this._requiredDuringSchedulingIgnoredDuringExecution.internalValue;
    }
}
export function deploymentSpecTemplateSpecAffinityToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        node_affinity: deploymentSpecTemplateSpecAffinityNodeAffinityToTerraform(struct.nodeAffinity),
        pod_affinity: deploymentSpecTemplateSpecAffinityPodAffinityToTerraform(struct.podAffinity),
        pod_anti_affinity: deploymentSpecTemplateSpecAffinityPodAntiAffinityToTerraform(struct.podAntiAffinity),
    };
}
export function deploymentSpecTemplateSpecAffinityToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        node_affinity: {
            value: deploymentSpecTemplateSpecAffinityNodeAffinityToHclTerraform(struct.nodeAffinity),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityNodeAffinityList",
        },
        pod_affinity: {
            value: deploymentSpecTemplateSpecAffinityPodAffinityToHclTerraform(struct.podAffinity),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAffinityList",
        },
        pod_anti_affinity: {
            value: deploymentSpecTemplateSpecAffinityPodAntiAffinityToHclTerraform(struct.podAntiAffinity),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityPodAntiAffinityList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecAffinityOutputReference extends cdktf.ComplexObject {
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
        if (this._nodeAffinity?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodeAffinity = this._nodeAffinity?.internalValue;
        }
        if (this._podAffinity?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.podAffinity = this._podAffinity?.internalValue;
        }
        if (this._podAntiAffinity?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.podAntiAffinity = this._podAntiAffinity?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._nodeAffinity.internalValue = undefined;
            this._podAffinity.internalValue = undefined;
            this._podAntiAffinity.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._nodeAffinity.internalValue = value.nodeAffinity;
            this._podAffinity.internalValue = value.podAffinity;
            this._podAntiAffinity.internalValue = value.podAntiAffinity;
        }
    }
    // node_affinity - computed: false, optional: true, required: false
    _nodeAffinity = new DeploymentSpecTemplateSpecAffinityNodeAffinityOutputReference(this, "node_affinity");
    get nodeAffinity() {
        return this._nodeAffinity;
    }
    putNodeAffinity(value) {
        this._nodeAffinity.internalValue = value;
    }
    resetNodeAffinity() {
        this._nodeAffinity.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodeAffinityInput() {
        return this._nodeAffinity.internalValue;
    }
    // pod_affinity - computed: false, optional: true, required: false
    _podAffinity = new DeploymentSpecTemplateSpecAffinityPodAffinityOutputReference(this, "pod_affinity");
    get podAffinity() {
        return this._podAffinity;
    }
    putPodAffinity(value) {
        this._podAffinity.internalValue = value;
    }
    resetPodAffinity() {
        this._podAffinity.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get podAffinityInput() {
        return this._podAffinity.internalValue;
    }
    // pod_anti_affinity - computed: false, optional: true, required: false
    _podAntiAffinity = new DeploymentSpecTemplateSpecAffinityPodAntiAffinityOutputReference(this, "pod_anti_affinity");
    get podAntiAffinity() {
        return this._podAntiAffinity;
    }
    putPodAntiAffinity(value) {
        this._podAntiAffinity.internalValue = value;
    }
    resetPodAntiAffinity() {
        this._podAntiAffinity.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get podAntiAffinityInput() {
        return this._podAntiAffinity.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerEnvValueFromConfigMapKeyRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecContainerEnvValueFromConfigMapKeyRefToHclTerraform(struct) {
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
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvValueFromConfigMapKeyRefOutputReference extends cdktf.ComplexObject {
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
        if (this._key !== undefined) {
            hasAnyValues = true;
            internalValueResult.key = this._key;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._key = undefined;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._key = value.key;
            this._name = value.name;
            this._optional = value.optional;
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
    // name - computed: false, optional: true, required: false
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecContainerEnvValueFromFieldRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        api_version: cdktf.stringToTerraform(struct.apiVersion),
        field_path: cdktf.stringToTerraform(struct.fieldPath),
    };
}
export function deploymentSpecTemplateSpecContainerEnvValueFromFieldRefToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        api_version: {
            value: cdktf.stringToHclTerraform(struct.apiVersion),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        field_path: {
            value: cdktf.stringToHclTerraform(struct.fieldPath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvValueFromFieldRefOutputReference extends cdktf.ComplexObject {
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
        if (this._apiVersion !== undefined) {
            hasAnyValues = true;
            internalValueResult.apiVersion = this._apiVersion;
        }
        if (this._fieldPath !== undefined) {
            hasAnyValues = true;
            internalValueResult.fieldPath = this._fieldPath;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._apiVersion = undefined;
            this._fieldPath = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._apiVersion = value.apiVersion;
            this._fieldPath = value.fieldPath;
        }
    }
    // api_version - computed: false, optional: true, required: false
    _apiVersion;
    get apiVersion() {
        return this.getStringAttribute('api_version');
    }
    set apiVersion(value) {
        this._apiVersion = value;
    }
    resetApiVersion() {
        this._apiVersion = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get apiVersionInput() {
        return this._apiVersion;
    }
    // field_path - computed: false, optional: true, required: false
    _fieldPath;
    get fieldPath() {
        return this.getStringAttribute('field_path');
    }
    set fieldPath(value) {
        this._fieldPath = value;
    }
    resetFieldPath() {
        this._fieldPath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fieldPathInput() {
        return this._fieldPath;
    }
}
export function deploymentSpecTemplateSpecContainerEnvValueFromResourceFieldRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        container_name: cdktf.stringToTerraform(struct.containerName),
        divisor: cdktf.stringToTerraform(struct.divisor),
        resource: cdktf.stringToTerraform(struct.resource),
    };
}
export function deploymentSpecTemplateSpecContainerEnvValueFromResourceFieldRefToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        container_name: {
            value: cdktf.stringToHclTerraform(struct.containerName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        divisor: {
            value: cdktf.stringToHclTerraform(struct.divisor),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        resource: {
            value: cdktf.stringToHclTerraform(struct.resource),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvValueFromResourceFieldRefOutputReference extends cdktf.ComplexObject {
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
        if (this._containerName !== undefined) {
            hasAnyValues = true;
            internalValueResult.containerName = this._containerName;
        }
        if (this._divisor !== undefined) {
            hasAnyValues = true;
            internalValueResult.divisor = this._divisor;
        }
        if (this._resource !== undefined) {
            hasAnyValues = true;
            internalValueResult.resource = this._resource;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._containerName = undefined;
            this._divisor = undefined;
            this._resource = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._containerName = value.containerName;
            this._divisor = value.divisor;
            this._resource = value.resource;
        }
    }
    // container_name - computed: false, optional: true, required: false
    _containerName;
    get containerName() {
        return this.getStringAttribute('container_name');
    }
    set containerName(value) {
        this._containerName = value;
    }
    resetContainerName() {
        this._containerName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get containerNameInput() {
        return this._containerName;
    }
    // divisor - computed: false, optional: true, required: false
    _divisor;
    get divisor() {
        return this.getStringAttribute('divisor');
    }
    set divisor(value) {
        this._divisor = value;
    }
    resetDivisor() {
        this._divisor = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get divisorInput() {
        return this._divisor;
    }
    // resource - computed: false, optional: false, required: true
    _resource;
    get resource() {
        return this.getStringAttribute('resource');
    }
    set resource(value) {
        this._resource = value;
    }
    // Temporarily expose input value. Use with caution.
    get resourceInput() {
        return this._resource;
    }
}
export function deploymentSpecTemplateSpecContainerEnvValueFromSecretKeyRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecContainerEnvValueFromSecretKeyRefToHclTerraform(struct) {
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
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvValueFromSecretKeyRefOutputReference extends cdktf.ComplexObject {
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
        if (this._key !== undefined) {
            hasAnyValues = true;
            internalValueResult.key = this._key;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._key = undefined;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._key = value.key;
            this._name = value.name;
            this._optional = value.optional;
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
    // name - computed: false, optional: true, required: false
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecContainerEnvValueFromToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        config_map_key_ref: deploymentSpecTemplateSpecContainerEnvValueFromConfigMapKeyRefToTerraform(struct.configMapKeyRef),
        field_ref: deploymentSpecTemplateSpecContainerEnvValueFromFieldRefToTerraform(struct.fieldRef),
        resource_field_ref: deploymentSpecTemplateSpecContainerEnvValueFromResourceFieldRefToTerraform(struct.resourceFieldRef),
        secret_key_ref: deploymentSpecTemplateSpecContainerEnvValueFromSecretKeyRefToTerraform(struct.secretKeyRef),
    };
}
export function deploymentSpecTemplateSpecContainerEnvValueFromToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        config_map_key_ref: {
            value: deploymentSpecTemplateSpecContainerEnvValueFromConfigMapKeyRefToHclTerraform(struct.configMapKeyRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvValueFromConfigMapKeyRefList",
        },
        field_ref: {
            value: deploymentSpecTemplateSpecContainerEnvValueFromFieldRefToHclTerraform(struct.fieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvValueFromFieldRefList",
        },
        resource_field_ref: {
            value: deploymentSpecTemplateSpecContainerEnvValueFromResourceFieldRefToHclTerraform(struct.resourceFieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvValueFromResourceFieldRefList",
        },
        secret_key_ref: {
            value: deploymentSpecTemplateSpecContainerEnvValueFromSecretKeyRefToHclTerraform(struct.secretKeyRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvValueFromSecretKeyRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvValueFromOutputReference extends cdktf.ComplexObject {
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
        if (this._configMapKeyRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.configMapKeyRef = this._configMapKeyRef?.internalValue;
        }
        if (this._fieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.fieldRef = this._fieldRef?.internalValue;
        }
        if (this._resourceFieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.resourceFieldRef = this._resourceFieldRef?.internalValue;
        }
        if (this._secretKeyRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretKeyRef = this._secretKeyRef?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._configMapKeyRef.internalValue = undefined;
            this._fieldRef.internalValue = undefined;
            this._resourceFieldRef.internalValue = undefined;
            this._secretKeyRef.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._configMapKeyRef.internalValue = value.configMapKeyRef;
            this._fieldRef.internalValue = value.fieldRef;
            this._resourceFieldRef.internalValue = value.resourceFieldRef;
            this._secretKeyRef.internalValue = value.secretKeyRef;
        }
    }
    // config_map_key_ref - computed: false, optional: true, required: false
    _configMapKeyRef = new DeploymentSpecTemplateSpecContainerEnvValueFromConfigMapKeyRefOutputReference(this, "config_map_key_ref");
    get configMapKeyRef() {
        return this._configMapKeyRef;
    }
    putConfigMapKeyRef(value) {
        this._configMapKeyRef.internalValue = value;
    }
    resetConfigMapKeyRef() {
        this._configMapKeyRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configMapKeyRefInput() {
        return this._configMapKeyRef.internalValue;
    }
    // field_ref - computed: false, optional: true, required: false
    _fieldRef = new DeploymentSpecTemplateSpecContainerEnvValueFromFieldRefOutputReference(this, "field_ref");
    get fieldRef() {
        return this._fieldRef;
    }
    putFieldRef(value) {
        this._fieldRef.internalValue = value;
    }
    resetFieldRef() {
        this._fieldRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fieldRefInput() {
        return this._fieldRef.internalValue;
    }
    // resource_field_ref - computed: false, optional: true, required: false
    _resourceFieldRef = new DeploymentSpecTemplateSpecContainerEnvValueFromResourceFieldRefOutputReference(this, "resource_field_ref");
    get resourceFieldRef() {
        return this._resourceFieldRef;
    }
    putResourceFieldRef(value) {
        this._resourceFieldRef.internalValue = value;
    }
    resetResourceFieldRef() {
        this._resourceFieldRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get resourceFieldRefInput() {
        return this._resourceFieldRef.internalValue;
    }
    // secret_key_ref - computed: false, optional: true, required: false
    _secretKeyRef = new DeploymentSpecTemplateSpecContainerEnvValueFromSecretKeyRefOutputReference(this, "secret_key_ref");
    get secretKeyRef() {
        return this._secretKeyRef;
    }
    putSecretKeyRef(value) {
        this._secretKeyRef.internalValue = value;
    }
    resetSecretKeyRef() {
        this._secretKeyRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretKeyRefInput() {
        return this._secretKeyRef.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerEnvToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
        value_from: deploymentSpecTemplateSpecContainerEnvValueFromToTerraform(struct.valueFrom),
    };
}
export function deploymentSpecTemplateSpecContainerEnvToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        value_from: {
            value: deploymentSpecTemplateSpecContainerEnvValueFromToHclTerraform(struct.valueFrom),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvValueFromList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvOutputReference extends cdktf.ComplexObject {
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
        if (this._valueFrom?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.valueFrom = this._valueFrom?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._value = undefined;
            this._valueFrom.internalValue = undefined;
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
            this._valueFrom.internalValue = value.valueFrom;
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
    // value_from - computed: false, optional: true, required: false
    _valueFrom = new DeploymentSpecTemplateSpecContainerEnvValueFromOutputReference(this, "value_from");
    get valueFrom() {
        return this._valueFrom;
    }
    putValueFrom(value) {
        this._valueFrom.internalValue = value;
    }
    resetValueFrom() {
        this._valueFrom.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueFromInput() {
        return this._valueFrom.internalValue;
    }
}
export class DeploymentSpecTemplateSpecContainerEnvList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerEnvOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerEnvFromConfigMapRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecContainerEnvFromConfigMapRefToHclTerraform(struct) {
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
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvFromConfigMapRefOutputReference extends cdktf.ComplexObject {
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
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
            this._optional = value.optional;
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecContainerEnvFromSecretRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecContainerEnvFromSecretRefToHclTerraform(struct) {
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
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvFromSecretRefOutputReference extends cdktf.ComplexObject {
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
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
            this._optional = value.optional;
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecContainerEnvFromToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        prefix: cdktf.stringToTerraform(struct.prefix),
        config_map_ref: deploymentSpecTemplateSpecContainerEnvFromConfigMapRefToTerraform(struct.configMapRef),
        secret_ref: deploymentSpecTemplateSpecContainerEnvFromSecretRefToTerraform(struct.secretRef),
    };
}
export function deploymentSpecTemplateSpecContainerEnvFromToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        prefix: {
            value: cdktf.stringToHclTerraform(struct.prefix),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        config_map_ref: {
            value: deploymentSpecTemplateSpecContainerEnvFromConfigMapRefToHclTerraform(struct.configMapRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvFromConfigMapRefList",
        },
        secret_ref: {
            value: deploymentSpecTemplateSpecContainerEnvFromSecretRefToHclTerraform(struct.secretRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvFromSecretRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerEnvFromOutputReference extends cdktf.ComplexObject {
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
        if (this._prefix !== undefined) {
            hasAnyValues = true;
            internalValueResult.prefix = this._prefix;
        }
        if (this._configMapRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.configMapRef = this._configMapRef?.internalValue;
        }
        if (this._secretRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretRef = this._secretRef?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._prefix = undefined;
            this._configMapRef.internalValue = undefined;
            this._secretRef.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._prefix = value.prefix;
            this._configMapRef.internalValue = value.configMapRef;
            this._secretRef.internalValue = value.secretRef;
        }
    }
    // prefix - computed: false, optional: true, required: false
    _prefix;
    get prefix() {
        return this.getStringAttribute('prefix');
    }
    set prefix(value) {
        this._prefix = value;
    }
    resetPrefix() {
        this._prefix = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get prefixInput() {
        return this._prefix;
    }
    // config_map_ref - computed: false, optional: true, required: false
    _configMapRef = new DeploymentSpecTemplateSpecContainerEnvFromConfigMapRefOutputReference(this, "config_map_ref");
    get configMapRef() {
        return this._configMapRef;
    }
    putConfigMapRef(value) {
        this._configMapRef.internalValue = value;
    }
    resetConfigMapRef() {
        this._configMapRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configMapRefInput() {
        return this._configMapRef.internalValue;
    }
    // secret_ref - computed: false, optional: true, required: false
    _secretRef = new DeploymentSpecTemplateSpecContainerEnvFromSecretRefOutputReference(this, "secret_ref");
    get secretRef() {
        return this._secretRef;
    }
    putSecretRef(value) {
        this._secretRef.internalValue = value;
    }
    resetSecretRef() {
        this._secretRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretRefInput() {
        return this._secretRef.internalValue;
    }
}
export class DeploymentSpecTemplateSpecContainerEnvFromList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerEnvFromOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
    // name - computed: false, optional: true, required: false
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        host: cdktf.stringToTerraform(struct.host),
        path: cdktf.stringToTerraform(struct.path),
        port: cdktf.stringToTerraform(struct.port),
        scheme: cdktf.stringToTerraform(struct.scheme),
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheme: {
            value: cdktf.stringToHclTerraform(struct.scheme),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        http_header: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetOutputReference extends cdktf.ComplexObject {
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
        if (this._host !== undefined) {
            hasAnyValues = true;
            internalValueResult.host = this._host;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._scheme !== undefined) {
            hasAnyValues = true;
            internalValueResult.scheme = this._scheme;
        }
        if (this._httpHeader?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpHeader = this._httpHeader?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._host = undefined;
            this._path = undefined;
            this._port = undefined;
            this._scheme = undefined;
            this._httpHeader.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._host = value.host;
            this._path = value.path;
            this._port = value.port;
            this._scheme = value.scheme;
            this._httpHeader.internalValue = value.httpHeader;
        }
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this.getStringAttribute('host');
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // path - computed: false, optional: true, required: false
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    resetPath() {
        this._path = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // port - computed: false, optional: true, required: false
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    resetPort() {
        this._port = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // scheme - computed: false, optional: true, required: false
    _scheme;
    get scheme() {
        return this.getStringAttribute('scheme');
    }
    set scheme(value) {
        this._scheme = value;
    }
    resetScheme() {
        this._scheme = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schemeInput() {
        return this._scheme;
    }
    // http_header - computed: false, optional: true, required: false
    _httpHeader = new DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetHttpHeaderList(this, "http_header", false);
    get httpHeader() {
        return this._httpHeader;
    }
    putHttpHeader(value) {
        this._httpHeader.internalValue = value;
    }
    resetHttpHeader() {
        this._httpHeader.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpHeaderInput() {
        return this._httpHeader.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.stringToTerraform(struct.port),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        exec: deploymentSpecTemplateSpecContainerLifecyclePostStartExecToTerraform(struct.exec),
        http_get: deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePostStartToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        exec: {
            value: deploymentSpecTemplateSpecContainerLifecyclePostStartExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePostStartExecList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartOutputReference extends cdktf.ComplexObject {
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
        if (this._exec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.exec = this._exec?.internalValue;
        }
        if (this._httpGet?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpGet = this._httpGet?.internalValue;
        }
        if (this._tcpSocket?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.tcpSocket = this._tcpSocket?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._exec.internalValue = undefined;
            this._httpGet.internalValue = undefined;
            this._tcpSocket.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._exec.internalValue = value.exec;
            this._httpGet.internalValue = value.httpGet;
            this._tcpSocket.internalValue = value.tcpSocket;
        }
    }
    // exec - computed: false, optional: true, required: false
    _exec = new DeploymentSpecTemplateSpecContainerLifecyclePostStartExecOutputReference(this, "exec");
    get exec() {
        return this._exec;
    }
    putExec(value) {
        this._exec.internalValue = value;
    }
    resetExec() {
        this._exec.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec.internalValue;
    }
    // http_get - computed: false, optional: true, required: false
    _httpGet = new DeploymentSpecTemplateSpecContainerLifecyclePostStartHttpGetOutputReference(this, "http_get");
    get httpGet() {
        return this._httpGet;
    }
    putHttpGet(value) {
        this._httpGet.internalValue = value;
    }
    resetHttpGet() {
        this._httpGet.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpGetInput() {
        return this._httpGet.internalValue;
    }
    // tcp_socket - computed: false, optional: true, required: false
    _tcpSocket = new DeploymentSpecTemplateSpecContainerLifecyclePostStartTcpSocketList(this, "tcp_socket", false);
    get tcpSocket() {
        return this._tcpSocket;
    }
    putTcpSocket(value) {
        this._tcpSocket.internalValue = value;
    }
    resetTcpSocket() {
        this._tcpSocket.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tcpSocketInput() {
        return this._tcpSocket.internalValue;
    }
}
export class DeploymentSpecTemplateSpecContainerLifecyclePostStartList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLifecyclePostStartOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
    // name - computed: false, optional: true, required: false
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        host: cdktf.stringToTerraform(struct.host),
        path: cdktf.stringToTerraform(struct.path),
        port: cdktf.stringToTerraform(struct.port),
        scheme: cdktf.stringToTerraform(struct.scheme),
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheme: {
            value: cdktf.stringToHclTerraform(struct.scheme),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        http_header: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetOutputReference extends cdktf.ComplexObject {
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
        if (this._host !== undefined) {
            hasAnyValues = true;
            internalValueResult.host = this._host;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._scheme !== undefined) {
            hasAnyValues = true;
            internalValueResult.scheme = this._scheme;
        }
        if (this._httpHeader?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpHeader = this._httpHeader?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._host = undefined;
            this._path = undefined;
            this._port = undefined;
            this._scheme = undefined;
            this._httpHeader.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._host = value.host;
            this._path = value.path;
            this._port = value.port;
            this._scheme = value.scheme;
            this._httpHeader.internalValue = value.httpHeader;
        }
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this.getStringAttribute('host');
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // path - computed: false, optional: true, required: false
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    resetPath() {
        this._path = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // port - computed: false, optional: true, required: false
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    resetPort() {
        this._port = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // scheme - computed: false, optional: true, required: false
    _scheme;
    get scheme() {
        return this.getStringAttribute('scheme');
    }
    set scheme(value) {
        this._scheme = value;
    }
    resetScheme() {
        this._scheme = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schemeInput() {
        return this._scheme;
    }
    // http_header - computed: false, optional: true, required: false
    _httpHeader = new DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetHttpHeaderList(this, "http_header", false);
    get httpHeader() {
        return this._httpHeader;
    }
    putHttpHeader(value) {
        this._httpHeader.internalValue = value;
    }
    resetHttpHeader() {
        this._httpHeader.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpHeaderInput() {
        return this._httpHeader.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.stringToTerraform(struct.port),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        exec: deploymentSpecTemplateSpecContainerLifecyclePreStopExecToTerraform(struct.exec),
        http_get: deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecContainerLifecyclePreStopToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        exec: {
            value: deploymentSpecTemplateSpecContainerLifecyclePreStopExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePreStopExecList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopOutputReference extends cdktf.ComplexObject {
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
        if (this._exec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.exec = this._exec?.internalValue;
        }
        if (this._httpGet?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpGet = this._httpGet?.internalValue;
        }
        if (this._tcpSocket?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.tcpSocket = this._tcpSocket?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._exec.internalValue = undefined;
            this._httpGet.internalValue = undefined;
            this._tcpSocket.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._exec.internalValue = value.exec;
            this._httpGet.internalValue = value.httpGet;
            this._tcpSocket.internalValue = value.tcpSocket;
        }
    }
    // exec - computed: false, optional: true, required: false
    _exec = new DeploymentSpecTemplateSpecContainerLifecyclePreStopExecOutputReference(this, "exec");
    get exec() {
        return this._exec;
    }
    putExec(value) {
        this._exec.internalValue = value;
    }
    resetExec() {
        this._exec.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec.internalValue;
    }
    // http_get - computed: false, optional: true, required: false
    _httpGet = new DeploymentSpecTemplateSpecContainerLifecyclePreStopHttpGetOutputReference(this, "http_get");
    get httpGet() {
        return this._httpGet;
    }
    putHttpGet(value) {
        this._httpGet.internalValue = value;
    }
    resetHttpGet() {
        this._httpGet.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpGetInput() {
        return this._httpGet.internalValue;
    }
    // tcp_socket - computed: false, optional: true, required: false
    _tcpSocket = new DeploymentSpecTemplateSpecContainerLifecyclePreStopTcpSocketList(this, "tcp_socket", false);
    get tcpSocket() {
        return this._tcpSocket;
    }
    putTcpSocket(value) {
        this._tcpSocket.internalValue = value;
    }
    resetTcpSocket() {
        this._tcpSocket.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tcpSocketInput() {
        return this._tcpSocket.internalValue;
    }
}
export class DeploymentSpecTemplateSpecContainerLifecyclePreStopList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLifecyclePreStopOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLifecycleToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        post_start: cdktf.listMapper(deploymentSpecTemplateSpecContainerLifecyclePostStartToTerraform, true)(struct.postStart),
        pre_stop: cdktf.listMapper(deploymentSpecTemplateSpecContainerLifecyclePreStopToTerraform, true)(struct.preStop),
    };
}
export function deploymentSpecTemplateSpecContainerLifecycleToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        post_start: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLifecyclePostStartToHclTerraform, true)(struct.postStart),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePostStartList",
        },
        pre_stop: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLifecyclePreStopToHclTerraform, true)(struct.preStop),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecyclePreStopList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLifecycleOutputReference extends cdktf.ComplexObject {
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
        if (this._postStart?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.postStart = this._postStart?.internalValue;
        }
        if (this._preStop?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.preStop = this._preStop?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._postStart.internalValue = undefined;
            this._preStop.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._postStart.internalValue = value.postStart;
            this._preStop.internalValue = value.preStop;
        }
    }
    // post_start - computed: false, optional: true, required: false
    _postStart = new DeploymentSpecTemplateSpecContainerLifecyclePostStartList(this, "post_start", false);
    get postStart() {
        return this._postStart;
    }
    putPostStart(value) {
        this._postStart.internalValue = value;
    }
    resetPostStart() {
        this._postStart.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get postStartInput() {
        return this._postStart.internalValue;
    }
    // pre_stop - computed: false, optional: true, required: false
    _preStop = new DeploymentSpecTemplateSpecContainerLifecyclePreStopList(this, "pre_stop", false);
    get preStop() {
        return this._preStop;
    }
    putPreStop(value) {
        this._preStop.internalValue = value;
    }
    resetPreStop() {
        this._preStop.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get preStopInput() {
        return this._preStop.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerLivenessProbeExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecContainerLivenessProbeExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecContainerLivenessProbeGrpcToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.numberToTerraform(struct.port),
        service: cdktf.stringToTerraform(struct.service),
    };
}
export function deploymentSpecTemplateSpecContainerLivenessProbeGrpcToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.numberToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        service: {
            value: cdktf.stringToHclTerraform(struct.service),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeGrpcOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._service !== undefined) {
            hasAnyValues = true;
            internalValueResult.service = this._service;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
            this._service = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
            this._service = value.service;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getNumberAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // service - computed: false, optional: true, required: false
    _service;
    get service() {
        return this.getStringAttribute('service');
    }
    set service(value) {
        this._service = value;
    }
    resetService() {
        this._service = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get serviceInput() {
        return this._service;
    }
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeGrpcList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLivenessProbeGrpcOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
    // name - computed: false, optional: true, required: false
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLivenessProbeHttpGetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        host: cdktf.stringToTerraform(struct.host),
        path: cdktf.stringToTerraform(struct.path),
        port: cdktf.stringToTerraform(struct.port),
        scheme: cdktf.stringToTerraform(struct.scheme),
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecContainerLivenessProbeHttpGetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheme: {
            value: cdktf.stringToHclTerraform(struct.scheme),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        http_header: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetOutputReference extends cdktf.ComplexObject {
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
        if (this._host !== undefined) {
            hasAnyValues = true;
            internalValueResult.host = this._host;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._scheme !== undefined) {
            hasAnyValues = true;
            internalValueResult.scheme = this._scheme;
        }
        if (this._httpHeader?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpHeader = this._httpHeader?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._host = undefined;
            this._path = undefined;
            this._port = undefined;
            this._scheme = undefined;
            this._httpHeader.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._host = value.host;
            this._path = value.path;
            this._port = value.port;
            this._scheme = value.scheme;
            this._httpHeader.internalValue = value.httpHeader;
        }
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this.getStringAttribute('host');
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // path - computed: false, optional: true, required: false
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    resetPath() {
        this._path = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // port - computed: false, optional: true, required: false
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    resetPort() {
        this._port = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // scheme - computed: false, optional: true, required: false
    _scheme;
    get scheme() {
        return this.getStringAttribute('scheme');
    }
    set scheme(value) {
        this._scheme = value;
    }
    resetScheme() {
        this._scheme = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schemeInput() {
        return this._scheme;
    }
    // http_header - computed: false, optional: true, required: false
    _httpHeader = new DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetHttpHeaderList(this, "http_header", false);
    get httpHeader() {
        return this._httpHeader;
    }
    putHttpHeader(value) {
        this._httpHeader.internalValue = value;
    }
    resetHttpHeader() {
        this._httpHeader.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpHeaderInput() {
        return this._httpHeader.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerLivenessProbeTcpSocketToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.stringToTerraform(struct.port),
    };
}
export function deploymentSpecTemplateSpecContainerLivenessProbeTcpSocketToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeTcpSocketOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerLivenessProbeTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerLivenessProbeToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        failure_threshold: cdktf.numberToTerraform(struct.failureThreshold),
        initial_delay_seconds: cdktf.numberToTerraform(struct.initialDelaySeconds),
        period_seconds: cdktf.numberToTerraform(struct.periodSeconds),
        success_threshold: cdktf.numberToTerraform(struct.successThreshold),
        timeout_seconds: cdktf.numberToTerraform(struct.timeoutSeconds),
        exec: deploymentSpecTemplateSpecContainerLivenessProbeExecToTerraform(struct.exec),
        grpc: cdktf.listMapper(deploymentSpecTemplateSpecContainerLivenessProbeGrpcToTerraform, true)(struct.grpc),
        http_get: deploymentSpecTemplateSpecContainerLivenessProbeHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecContainerLivenessProbeTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecContainerLivenessProbeToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        failure_threshold: {
            value: cdktf.numberToHclTerraform(struct.failureThreshold),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        initial_delay_seconds: {
            value: cdktf.numberToHclTerraform(struct.initialDelaySeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        period_seconds: {
            value: cdktf.numberToHclTerraform(struct.periodSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        success_threshold: {
            value: cdktf.numberToHclTerraform(struct.successThreshold),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        timeout_seconds: {
            value: cdktf.numberToHclTerraform(struct.timeoutSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        exec: {
            value: deploymentSpecTemplateSpecContainerLivenessProbeExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLivenessProbeExecList",
        },
        grpc: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLivenessProbeGrpcToHclTerraform, true)(struct.grpc),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLivenessProbeGrpcList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecContainerLivenessProbeHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerLivenessProbeTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLivenessProbeTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerLivenessProbeOutputReference extends cdktf.ComplexObject {
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
        if (this._failureThreshold !== undefined) {
            hasAnyValues = true;
            internalValueResult.failureThreshold = this._failureThreshold;
        }
        if (this._initialDelaySeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.initialDelaySeconds = this._initialDelaySeconds;
        }
        if (this._periodSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.periodSeconds = this._periodSeconds;
        }
        if (this._successThreshold !== undefined) {
            hasAnyValues = true;
            internalValueResult.successThreshold = this._successThreshold;
        }
        if (this._timeoutSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.timeoutSeconds = this._timeoutSeconds;
        }
        if (this._exec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.exec = this._exec?.internalValue;
        }
        if (this._grpc?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.grpc = this._grpc?.internalValue;
        }
        if (this._httpGet?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpGet = this._httpGet?.internalValue;
        }
        if (this._tcpSocket?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.tcpSocket = this._tcpSocket?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._failureThreshold = undefined;
            this._initialDelaySeconds = undefined;
            this._periodSeconds = undefined;
            this._successThreshold = undefined;
            this._timeoutSeconds = undefined;
            this._exec.internalValue = undefined;
            this._grpc.internalValue = undefined;
            this._httpGet.internalValue = undefined;
            this._tcpSocket.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._failureThreshold = value.failureThreshold;
            this._initialDelaySeconds = value.initialDelaySeconds;
            this._periodSeconds = value.periodSeconds;
            this._successThreshold = value.successThreshold;
            this._timeoutSeconds = value.timeoutSeconds;
            this._exec.internalValue = value.exec;
            this._grpc.internalValue = value.grpc;
            this._httpGet.internalValue = value.httpGet;
            this._tcpSocket.internalValue = value.tcpSocket;
        }
    }
    // failure_threshold - computed: false, optional: true, required: false
    _failureThreshold;
    get failureThreshold() {
        return this.getNumberAttribute('failure_threshold');
    }
    set failureThreshold(value) {
        this._failureThreshold = value;
    }
    resetFailureThreshold() {
        this._failureThreshold = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get failureThresholdInput() {
        return this._failureThreshold;
    }
    // initial_delay_seconds - computed: false, optional: true, required: false
    _initialDelaySeconds;
    get initialDelaySeconds() {
        return this.getNumberAttribute('initial_delay_seconds');
    }
    set initialDelaySeconds(value) {
        this._initialDelaySeconds = value;
    }
    resetInitialDelaySeconds() {
        this._initialDelaySeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get initialDelaySecondsInput() {
        return this._initialDelaySeconds;
    }
    // period_seconds - computed: false, optional: true, required: false
    _periodSeconds;
    get periodSeconds() {
        return this.getNumberAttribute('period_seconds');
    }
    set periodSeconds(value) {
        this._periodSeconds = value;
    }
    resetPeriodSeconds() {
        this._periodSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get periodSecondsInput() {
        return this._periodSeconds;
    }
    // success_threshold - computed: false, optional: true, required: false
    _successThreshold;
    get successThreshold() {
        return this.getNumberAttribute('success_threshold');
    }
    set successThreshold(value) {
        this._successThreshold = value;
    }
    resetSuccessThreshold() {
        this._successThreshold = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get successThresholdInput() {
        return this._successThreshold;
    }
    // timeout_seconds - computed: false, optional: true, required: false
    _timeoutSeconds;
    get timeoutSeconds() {
        return this.getNumberAttribute('timeout_seconds');
    }
    set timeoutSeconds(value) {
        this._timeoutSeconds = value;
    }
    resetTimeoutSeconds() {
        this._timeoutSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get timeoutSecondsInput() {
        return this._timeoutSeconds;
    }
    // exec - computed: false, optional: true, required: false
    _exec = new DeploymentSpecTemplateSpecContainerLivenessProbeExecOutputReference(this, "exec");
    get exec() {
        return this._exec;
    }
    putExec(value) {
        this._exec.internalValue = value;
    }
    resetExec() {
        this._exec.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec.internalValue;
    }
    // grpc - computed: false, optional: true, required: false
    _grpc = new DeploymentSpecTemplateSpecContainerLivenessProbeGrpcList(this, "grpc", false);
    get grpc() {
        return this._grpc;
    }
    putGrpc(value) {
        this._grpc.internalValue = value;
    }
    resetGrpc() {
        this._grpc.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get grpcInput() {
        return this._grpc.internalValue;
    }
    // http_get - computed: false, optional: true, required: false
    _httpGet = new DeploymentSpecTemplateSpecContainerLivenessProbeHttpGetOutputReference(this, "http_get");
    get httpGet() {
        return this._httpGet;
    }
    putHttpGet(value) {
        this._httpGet.internalValue = value;
    }
    resetHttpGet() {
        this._httpGet.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpGetInput() {
        return this._httpGet.internalValue;
    }
    // tcp_socket - computed: false, optional: true, required: false
    _tcpSocket = new DeploymentSpecTemplateSpecContainerLivenessProbeTcpSocketList(this, "tcp_socket", false);
    get tcpSocket() {
        return this._tcpSocket;
    }
    putTcpSocket(value) {
        this._tcpSocket.internalValue = value;
    }
    resetTcpSocket() {
        this._tcpSocket.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tcpSocketInput() {
        return this._tcpSocket.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerPortToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        container_port: cdktf.numberToTerraform(struct.containerPort),
        host_ip: cdktf.stringToTerraform(struct.hostIp),
        host_port: cdktf.numberToTerraform(struct.hostPort),
        name: cdktf.stringToTerraform(struct.name),
        protocol: cdktf.stringToTerraform(struct.protocol),
    };
}
export function deploymentSpecTemplateSpecContainerPortToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        container_port: {
            value: cdktf.numberToHclTerraform(struct.containerPort),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        host_ip: {
            value: cdktf.stringToHclTerraform(struct.hostIp),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        host_port: {
            value: cdktf.numberToHclTerraform(struct.hostPort),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        protocol: {
            value: cdktf.stringToHclTerraform(struct.protocol),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerPortOutputReference extends cdktf.ComplexObject {
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
        if (this._containerPort !== undefined) {
            hasAnyValues = true;
            internalValueResult.containerPort = this._containerPort;
        }
        if (this._hostIp !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostIp = this._hostIp;
        }
        if (this._hostPort !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostPort = this._hostPort;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._protocol !== undefined) {
            hasAnyValues = true;
            internalValueResult.protocol = this._protocol;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._containerPort = undefined;
            this._hostIp = undefined;
            this._hostPort = undefined;
            this._name = undefined;
            this._protocol = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._containerPort = value.containerPort;
            this._hostIp = value.hostIp;
            this._hostPort = value.hostPort;
            this._name = value.name;
            this._protocol = value.protocol;
        }
    }
    // container_port - computed: false, optional: false, required: true
    _containerPort;
    get containerPort() {
        return this.getNumberAttribute('container_port');
    }
    set containerPort(value) {
        this._containerPort = value;
    }
    // Temporarily expose input value. Use with caution.
    get containerPortInput() {
        return this._containerPort;
    }
    // host_ip - computed: false, optional: true, required: false
    _hostIp;
    get hostIp() {
        return this.getStringAttribute('host_ip');
    }
    set hostIp(value) {
        this._hostIp = value;
    }
    resetHostIp() {
        this._hostIp = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostIpInput() {
        return this._hostIp;
    }
    // host_port - computed: false, optional: true, required: false
    _hostPort;
    get hostPort() {
        return this.getNumberAttribute('host_port');
    }
    set hostPort(value) {
        this._hostPort = value;
    }
    resetHostPort() {
        this._hostPort = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostPortInput() {
        return this._hostPort;
    }
    // name - computed: false, optional: true, required: false
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
    // protocol - computed: false, optional: true, required: false
    _protocol;
    get protocol() {
        return this.getStringAttribute('protocol');
    }
    set protocol(value) {
        this._protocol = value;
    }
    resetProtocol() {
        this._protocol = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get protocolInput() {
        return this._protocol;
    }
}
export class DeploymentSpecTemplateSpecContainerPortList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerPortOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerReadinessProbeExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecContainerReadinessProbeExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecContainerReadinessProbeGrpcToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.numberToTerraform(struct.port),
        service: cdktf.stringToTerraform(struct.service),
    };
}
export function deploymentSpecTemplateSpecContainerReadinessProbeGrpcToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.numberToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        service: {
            value: cdktf.stringToHclTerraform(struct.service),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeGrpcOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._service !== undefined) {
            hasAnyValues = true;
            internalValueResult.service = this._service;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
            this._service = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
            this._service = value.service;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getNumberAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // service - computed: false, optional: true, required: false
    _service;
    get service() {
        return this.getStringAttribute('service');
    }
    set service(value) {
        this._service = value;
    }
    resetService() {
        this._service = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get serviceInput() {
        return this._service;
    }
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeGrpcList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerReadinessProbeGrpcOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
    // name - computed: false, optional: true, required: false
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerReadinessProbeHttpGetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        host: cdktf.stringToTerraform(struct.host),
        path: cdktf.stringToTerraform(struct.path),
        port: cdktf.stringToTerraform(struct.port),
        scheme: cdktf.stringToTerraform(struct.scheme),
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecContainerReadinessProbeHttpGetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheme: {
            value: cdktf.stringToHclTerraform(struct.scheme),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        http_header: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetOutputReference extends cdktf.ComplexObject {
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
        if (this._host !== undefined) {
            hasAnyValues = true;
            internalValueResult.host = this._host;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._scheme !== undefined) {
            hasAnyValues = true;
            internalValueResult.scheme = this._scheme;
        }
        if (this._httpHeader?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpHeader = this._httpHeader?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._host = undefined;
            this._path = undefined;
            this._port = undefined;
            this._scheme = undefined;
            this._httpHeader.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._host = value.host;
            this._path = value.path;
            this._port = value.port;
            this._scheme = value.scheme;
            this._httpHeader.internalValue = value.httpHeader;
        }
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this.getStringAttribute('host');
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // path - computed: false, optional: true, required: false
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    resetPath() {
        this._path = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // port - computed: false, optional: true, required: false
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    resetPort() {
        this._port = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // scheme - computed: false, optional: true, required: false
    _scheme;
    get scheme() {
        return this.getStringAttribute('scheme');
    }
    set scheme(value) {
        this._scheme = value;
    }
    resetScheme() {
        this._scheme = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schemeInput() {
        return this._scheme;
    }
    // http_header - computed: false, optional: true, required: false
    _httpHeader = new DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetHttpHeaderList(this, "http_header", false);
    get httpHeader() {
        return this._httpHeader;
    }
    putHttpHeader(value) {
        this._httpHeader.internalValue = value;
    }
    resetHttpHeader() {
        this._httpHeader.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpHeaderInput() {
        return this._httpHeader.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerReadinessProbeTcpSocketToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.stringToTerraform(struct.port),
    };
}
export function deploymentSpecTemplateSpecContainerReadinessProbeTcpSocketToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeTcpSocketOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerReadinessProbeTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerReadinessProbeToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        failure_threshold: cdktf.numberToTerraform(struct.failureThreshold),
        initial_delay_seconds: cdktf.numberToTerraform(struct.initialDelaySeconds),
        period_seconds: cdktf.numberToTerraform(struct.periodSeconds),
        success_threshold: cdktf.numberToTerraform(struct.successThreshold),
        timeout_seconds: cdktf.numberToTerraform(struct.timeoutSeconds),
        exec: deploymentSpecTemplateSpecContainerReadinessProbeExecToTerraform(struct.exec),
        grpc: cdktf.listMapper(deploymentSpecTemplateSpecContainerReadinessProbeGrpcToTerraform, true)(struct.grpc),
        http_get: deploymentSpecTemplateSpecContainerReadinessProbeHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecContainerReadinessProbeTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecContainerReadinessProbeToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        failure_threshold: {
            value: cdktf.numberToHclTerraform(struct.failureThreshold),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        initial_delay_seconds: {
            value: cdktf.numberToHclTerraform(struct.initialDelaySeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        period_seconds: {
            value: cdktf.numberToHclTerraform(struct.periodSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        success_threshold: {
            value: cdktf.numberToHclTerraform(struct.successThreshold),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        timeout_seconds: {
            value: cdktf.numberToHclTerraform(struct.timeoutSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        exec: {
            value: deploymentSpecTemplateSpecContainerReadinessProbeExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerReadinessProbeExecList",
        },
        grpc: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerReadinessProbeGrpcToHclTerraform, true)(struct.grpc),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerReadinessProbeGrpcList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecContainerReadinessProbeHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerReadinessProbeTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerReadinessProbeTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerReadinessProbeOutputReference extends cdktf.ComplexObject {
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
        if (this._failureThreshold !== undefined) {
            hasAnyValues = true;
            internalValueResult.failureThreshold = this._failureThreshold;
        }
        if (this._initialDelaySeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.initialDelaySeconds = this._initialDelaySeconds;
        }
        if (this._periodSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.periodSeconds = this._periodSeconds;
        }
        if (this._successThreshold !== undefined) {
            hasAnyValues = true;
            internalValueResult.successThreshold = this._successThreshold;
        }
        if (this._timeoutSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.timeoutSeconds = this._timeoutSeconds;
        }
        if (this._exec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.exec = this._exec?.internalValue;
        }
        if (this._grpc?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.grpc = this._grpc?.internalValue;
        }
        if (this._httpGet?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpGet = this._httpGet?.internalValue;
        }
        if (this._tcpSocket?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.tcpSocket = this._tcpSocket?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._failureThreshold = undefined;
            this._initialDelaySeconds = undefined;
            this._periodSeconds = undefined;
            this._successThreshold = undefined;
            this._timeoutSeconds = undefined;
            this._exec.internalValue = undefined;
            this._grpc.internalValue = undefined;
            this._httpGet.internalValue = undefined;
            this._tcpSocket.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._failureThreshold = value.failureThreshold;
            this._initialDelaySeconds = value.initialDelaySeconds;
            this._periodSeconds = value.periodSeconds;
            this._successThreshold = value.successThreshold;
            this._timeoutSeconds = value.timeoutSeconds;
            this._exec.internalValue = value.exec;
            this._grpc.internalValue = value.grpc;
            this._httpGet.internalValue = value.httpGet;
            this._tcpSocket.internalValue = value.tcpSocket;
        }
    }
    // failure_threshold - computed: false, optional: true, required: false
    _failureThreshold;
    get failureThreshold() {
        return this.getNumberAttribute('failure_threshold');
    }
    set failureThreshold(value) {
        this._failureThreshold = value;
    }
    resetFailureThreshold() {
        this._failureThreshold = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get failureThresholdInput() {
        return this._failureThreshold;
    }
    // initial_delay_seconds - computed: false, optional: true, required: false
    _initialDelaySeconds;
    get initialDelaySeconds() {
        return this.getNumberAttribute('initial_delay_seconds');
    }
    set initialDelaySeconds(value) {
        this._initialDelaySeconds = value;
    }
    resetInitialDelaySeconds() {
        this._initialDelaySeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get initialDelaySecondsInput() {
        return this._initialDelaySeconds;
    }
    // period_seconds - computed: false, optional: true, required: false
    _periodSeconds;
    get periodSeconds() {
        return this.getNumberAttribute('period_seconds');
    }
    set periodSeconds(value) {
        this._periodSeconds = value;
    }
    resetPeriodSeconds() {
        this._periodSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get periodSecondsInput() {
        return this._periodSeconds;
    }
    // success_threshold - computed: false, optional: true, required: false
    _successThreshold;
    get successThreshold() {
        return this.getNumberAttribute('success_threshold');
    }
    set successThreshold(value) {
        this._successThreshold = value;
    }
    resetSuccessThreshold() {
        this._successThreshold = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get successThresholdInput() {
        return this._successThreshold;
    }
    // timeout_seconds - computed: false, optional: true, required: false
    _timeoutSeconds;
    get timeoutSeconds() {
        return this.getNumberAttribute('timeout_seconds');
    }
    set timeoutSeconds(value) {
        this._timeoutSeconds = value;
    }
    resetTimeoutSeconds() {
        this._timeoutSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get timeoutSecondsInput() {
        return this._timeoutSeconds;
    }
    // exec - computed: false, optional: true, required: false
    _exec = new DeploymentSpecTemplateSpecContainerReadinessProbeExecOutputReference(this, "exec");
    get exec() {
        return this._exec;
    }
    putExec(value) {
        this._exec.internalValue = value;
    }
    resetExec() {
        this._exec.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec.internalValue;
    }
    // grpc - computed: false, optional: true, required: false
    _grpc = new DeploymentSpecTemplateSpecContainerReadinessProbeGrpcList(this, "grpc", false);
    get grpc() {
        return this._grpc;
    }
    putGrpc(value) {
        this._grpc.internalValue = value;
    }
    resetGrpc() {
        this._grpc.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get grpcInput() {
        return this._grpc.internalValue;
    }
    // http_get - computed: false, optional: true, required: false
    _httpGet = new DeploymentSpecTemplateSpecContainerReadinessProbeHttpGetOutputReference(this, "http_get");
    get httpGet() {
        return this._httpGet;
    }
    putHttpGet(value) {
        this._httpGet.internalValue = value;
    }
    resetHttpGet() {
        this._httpGet.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpGetInput() {
        return this._httpGet.internalValue;
    }
    // tcp_socket - computed: false, optional: true, required: false
    _tcpSocket = new DeploymentSpecTemplateSpecContainerReadinessProbeTcpSocketList(this, "tcp_socket", false);
    get tcpSocket() {
        return this._tcpSocket;
    }
    putTcpSocket(value) {
        this._tcpSocket.internalValue = value;
    }
    resetTcpSocket() {
        this._tcpSocket.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tcpSocketInput() {
        return this._tcpSocket.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerResourcesToTerraform(struct) {
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
export function deploymentSpecTemplateSpecContainerResourcesToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecContainerResourcesOutputReference extends cdktf.ComplexObject {
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
    // limits - computed: true, optional: true, required: false
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
    // requests - computed: true, optional: true, required: false
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
export function deploymentSpecTemplateSpecContainerSecurityContextCapabilitiesToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        add: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.add),
        drop: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.drop),
    };
}
export function deploymentSpecTemplateSpecContainerSecurityContextCapabilitiesToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        add: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.add),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        drop: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.drop),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerSecurityContextCapabilitiesOutputReference extends cdktf.ComplexObject {
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
        if (this._add !== undefined) {
            hasAnyValues = true;
            internalValueResult.add = this._add;
        }
        if (this._drop !== undefined) {
            hasAnyValues = true;
            internalValueResult.drop = this._drop;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._add = undefined;
            this._drop = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._add = value.add;
            this._drop = value.drop;
        }
    }
    // add - computed: false, optional: true, required: false
    _add;
    get add() {
        return this.getListAttribute('add');
    }
    set add(value) {
        this._add = value;
    }
    resetAdd() {
        this._add = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get addInput() {
        return this._add;
    }
    // drop - computed: false, optional: true, required: false
    _drop;
    get drop() {
        return this.getListAttribute('drop');
    }
    set drop(value) {
        this._drop = value;
    }
    resetDrop() {
        this._drop = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get dropInput() {
        return this._drop;
    }
}
export function deploymentSpecTemplateSpecContainerSecurityContextSeLinuxOptionsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        level: cdktf.stringToTerraform(struct.level),
        role: cdktf.stringToTerraform(struct.role),
        type: cdktf.stringToTerraform(struct.type),
        user: cdktf.stringToTerraform(struct.user),
    };
}
export function deploymentSpecTemplateSpecContainerSecurityContextSeLinuxOptionsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        level: {
            value: cdktf.stringToHclTerraform(struct.level),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        role: {
            value: cdktf.stringToHclTerraform(struct.role),
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
        user: {
            value: cdktf.stringToHclTerraform(struct.user),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerSecurityContextSeLinuxOptionsOutputReference extends cdktf.ComplexObject {
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
        if (this._level !== undefined) {
            hasAnyValues = true;
            internalValueResult.level = this._level;
        }
        if (this._role !== undefined) {
            hasAnyValues = true;
            internalValueResult.role = this._role;
        }
        if (this._type !== undefined) {
            hasAnyValues = true;
            internalValueResult.type = this._type;
        }
        if (this._user !== undefined) {
            hasAnyValues = true;
            internalValueResult.user = this._user;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._level = undefined;
            this._role = undefined;
            this._type = undefined;
            this._user = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._level = value.level;
            this._role = value.role;
            this._type = value.type;
            this._user = value.user;
        }
    }
    // level - computed: false, optional: true, required: false
    _level;
    get level() {
        return this.getStringAttribute('level');
    }
    set level(value) {
        this._level = value;
    }
    resetLevel() {
        this._level = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get levelInput() {
        return this._level;
    }
    // role - computed: false, optional: true, required: false
    _role;
    get role() {
        return this.getStringAttribute('role');
    }
    set role(value) {
        this._role = value;
    }
    resetRole() {
        this._role = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get roleInput() {
        return this._role;
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
    // user - computed: false, optional: true, required: false
    _user;
    get user() {
        return this.getStringAttribute('user');
    }
    set user(value) {
        this._user = value;
    }
    resetUser() {
        this._user = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get userInput() {
        return this._user;
    }
}
export function deploymentSpecTemplateSpecContainerSecurityContextSeccompProfileToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        localhost_profile: cdktf.stringToTerraform(struct.localhostProfile),
        type: cdktf.stringToTerraform(struct.type),
    };
}
export function deploymentSpecTemplateSpecContainerSecurityContextSeccompProfileToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        localhost_profile: {
            value: cdktf.stringToHclTerraform(struct.localhostProfile),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerSecurityContextSeccompProfileOutputReference extends cdktf.ComplexObject {
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
        if (this._localhostProfile !== undefined) {
            hasAnyValues = true;
            internalValueResult.localhostProfile = this._localhostProfile;
        }
        if (this._type !== undefined) {
            hasAnyValues = true;
            internalValueResult.type = this._type;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._localhostProfile = undefined;
            this._type = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._localhostProfile = value.localhostProfile;
            this._type = value.type;
        }
    }
    // localhost_profile - computed: false, optional: true, required: false
    _localhostProfile;
    get localhostProfile() {
        return this.getStringAttribute('localhost_profile');
    }
    set localhostProfile(value) {
        this._localhostProfile = value;
    }
    resetLocalhostProfile() {
        this._localhostProfile = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get localhostProfileInput() {
        return this._localhostProfile;
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
}
export function deploymentSpecTemplateSpecContainerSecurityContextToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        allow_privilege_escalation: cdktf.booleanToTerraform(struct.allowPrivilegeEscalation),
        privileged: cdktf.booleanToTerraform(struct.privileged),
        read_only_root_filesystem: cdktf.booleanToTerraform(struct.readOnlyRootFilesystem),
        run_as_group: cdktf.stringToTerraform(struct.runAsGroup),
        run_as_non_root: cdktf.booleanToTerraform(struct.runAsNonRoot),
        run_as_user: cdktf.stringToTerraform(struct.runAsUser),
        capabilities: deploymentSpecTemplateSpecContainerSecurityContextCapabilitiesToTerraform(struct.capabilities),
        se_linux_options: deploymentSpecTemplateSpecContainerSecurityContextSeLinuxOptionsToTerraform(struct.seLinuxOptions),
        seccomp_profile: deploymentSpecTemplateSpecContainerSecurityContextSeccompProfileToTerraform(struct.seccompProfile),
    };
}
export function deploymentSpecTemplateSpecContainerSecurityContextToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        allow_privilege_escalation: {
            value: cdktf.booleanToHclTerraform(struct.allowPrivilegeEscalation),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        privileged: {
            value: cdktf.booleanToHclTerraform(struct.privileged),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        read_only_root_filesystem: {
            value: cdktf.booleanToHclTerraform(struct.readOnlyRootFilesystem),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        run_as_group: {
            value: cdktf.stringToHclTerraform(struct.runAsGroup),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        run_as_non_root: {
            value: cdktf.booleanToHclTerraform(struct.runAsNonRoot),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        run_as_user: {
            value: cdktf.stringToHclTerraform(struct.runAsUser),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        capabilities: {
            value: deploymentSpecTemplateSpecContainerSecurityContextCapabilitiesToHclTerraform(struct.capabilities),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerSecurityContextCapabilitiesList",
        },
        se_linux_options: {
            value: deploymentSpecTemplateSpecContainerSecurityContextSeLinuxOptionsToHclTerraform(struct.seLinuxOptions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerSecurityContextSeLinuxOptionsList",
        },
        seccomp_profile: {
            value: deploymentSpecTemplateSpecContainerSecurityContextSeccompProfileToHclTerraform(struct.seccompProfile),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerSecurityContextSeccompProfileList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerSecurityContextOutputReference extends cdktf.ComplexObject {
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
        if (this._allowPrivilegeEscalation !== undefined) {
            hasAnyValues = true;
            internalValueResult.allowPrivilegeEscalation = this._allowPrivilegeEscalation;
        }
        if (this._privileged !== undefined) {
            hasAnyValues = true;
            internalValueResult.privileged = this._privileged;
        }
        if (this._readOnlyRootFilesystem !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnlyRootFilesystem = this._readOnlyRootFilesystem;
        }
        if (this._runAsGroup !== undefined) {
            hasAnyValues = true;
            internalValueResult.runAsGroup = this._runAsGroup;
        }
        if (this._runAsNonRoot !== undefined) {
            hasAnyValues = true;
            internalValueResult.runAsNonRoot = this._runAsNonRoot;
        }
        if (this._runAsUser !== undefined) {
            hasAnyValues = true;
            internalValueResult.runAsUser = this._runAsUser;
        }
        if (this._capabilities?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.capabilities = this._capabilities?.internalValue;
        }
        if (this._seLinuxOptions?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.seLinuxOptions = this._seLinuxOptions?.internalValue;
        }
        if (this._seccompProfile?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.seccompProfile = this._seccompProfile?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._allowPrivilegeEscalation = undefined;
            this._privileged = undefined;
            this._readOnlyRootFilesystem = undefined;
            this._runAsGroup = undefined;
            this._runAsNonRoot = undefined;
            this._runAsUser = undefined;
            this._capabilities.internalValue = undefined;
            this._seLinuxOptions.internalValue = undefined;
            this._seccompProfile.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._allowPrivilegeEscalation = value.allowPrivilegeEscalation;
            this._privileged = value.privileged;
            this._readOnlyRootFilesystem = value.readOnlyRootFilesystem;
            this._runAsGroup = value.runAsGroup;
            this._runAsNonRoot = value.runAsNonRoot;
            this._runAsUser = value.runAsUser;
            this._capabilities.internalValue = value.capabilities;
            this._seLinuxOptions.internalValue = value.seLinuxOptions;
            this._seccompProfile.internalValue = value.seccompProfile;
        }
    }
    // allow_privilege_escalation - computed: false, optional: true, required: false
    _allowPrivilegeEscalation;
    get allowPrivilegeEscalation() {
        return this.getBooleanAttribute('allow_privilege_escalation');
    }
    set allowPrivilegeEscalation(value) {
        this._allowPrivilegeEscalation = value;
    }
    resetAllowPrivilegeEscalation() {
        this._allowPrivilegeEscalation = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get allowPrivilegeEscalationInput() {
        return this._allowPrivilegeEscalation;
    }
    // privileged - computed: false, optional: true, required: false
    _privileged;
    get privileged() {
        return this.getBooleanAttribute('privileged');
    }
    set privileged(value) {
        this._privileged = value;
    }
    resetPrivileged() {
        this._privileged = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get privilegedInput() {
        return this._privileged;
    }
    // read_only_root_filesystem - computed: false, optional: true, required: false
    _readOnlyRootFilesystem;
    get readOnlyRootFilesystem() {
        return this.getBooleanAttribute('read_only_root_filesystem');
    }
    set readOnlyRootFilesystem(value) {
        this._readOnlyRootFilesystem = value;
    }
    resetReadOnlyRootFilesystem() {
        this._readOnlyRootFilesystem = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get readOnlyRootFilesystemInput() {
        return this._readOnlyRootFilesystem;
    }
    // run_as_group - computed: false, optional: true, required: false
    _runAsGroup;
    get runAsGroup() {
        return this.getStringAttribute('run_as_group');
    }
    set runAsGroup(value) {
        this._runAsGroup = value;
    }
    resetRunAsGroup() {
        this._runAsGroup = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get runAsGroupInput() {
        return this._runAsGroup;
    }
    // run_as_non_root - computed: false, optional: true, required: false
    _runAsNonRoot;
    get runAsNonRoot() {
        return this.getBooleanAttribute('run_as_non_root');
    }
    set runAsNonRoot(value) {
        this._runAsNonRoot = value;
    }
    resetRunAsNonRoot() {
        this._runAsNonRoot = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get runAsNonRootInput() {
        return this._runAsNonRoot;
    }
    // run_as_user - computed: false, optional: true, required: false
    _runAsUser;
    get runAsUser() {
        return this.getStringAttribute('run_as_user');
    }
    set runAsUser(value) {
        this._runAsUser = value;
    }
    resetRunAsUser() {
        this._runAsUser = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get runAsUserInput() {
        return this._runAsUser;
    }
    // capabilities - computed: false, optional: true, required: false
    _capabilities = new DeploymentSpecTemplateSpecContainerSecurityContextCapabilitiesOutputReference(this, "capabilities");
    get capabilities() {
        return this._capabilities;
    }
    putCapabilities(value) {
        this._capabilities.internalValue = value;
    }
    resetCapabilities() {
        this._capabilities.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get capabilitiesInput() {
        return this._capabilities.internalValue;
    }
    // se_linux_options - computed: false, optional: true, required: false
    _seLinuxOptions = new DeploymentSpecTemplateSpecContainerSecurityContextSeLinuxOptionsOutputReference(this, "se_linux_options");
    get seLinuxOptions() {
        return this._seLinuxOptions;
    }
    putSeLinuxOptions(value) {
        this._seLinuxOptions.internalValue = value;
    }
    resetSeLinuxOptions() {
        this._seLinuxOptions.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get seLinuxOptionsInput() {
        return this._seLinuxOptions.internalValue;
    }
    // seccomp_profile - computed: false, optional: true, required: false
    _seccompProfile = new DeploymentSpecTemplateSpecContainerSecurityContextSeccompProfileOutputReference(this, "seccomp_profile");
    get seccompProfile() {
        return this._seccompProfile;
    }
    putSeccompProfile(value) {
        this._seccompProfile.internalValue = value;
    }
    resetSeccompProfile() {
        this._seccompProfile.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get seccompProfileInput() {
        return this._seccompProfile.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerStartupProbeExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecContainerStartupProbeExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerStartupProbeExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecContainerStartupProbeGrpcToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.numberToTerraform(struct.port),
        service: cdktf.stringToTerraform(struct.service),
    };
}
export function deploymentSpecTemplateSpecContainerStartupProbeGrpcToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.numberToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        service: {
            value: cdktf.stringToHclTerraform(struct.service),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerStartupProbeGrpcOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._service !== undefined) {
            hasAnyValues = true;
            internalValueResult.service = this._service;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
            this._service = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
            this._service = value.service;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getNumberAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // service - computed: false, optional: true, required: false
    _service;
    get service() {
        return this.getStringAttribute('service');
    }
    set service(value) {
        this._service = value;
    }
    resetService() {
        this._service = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get serviceInput() {
        return this._service;
    }
}
export class DeploymentSpecTemplateSpecContainerStartupProbeGrpcList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerStartupProbeGrpcOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
    // name - computed: false, optional: true, required: false
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerStartupProbeHttpGetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        host: cdktf.stringToTerraform(struct.host),
        path: cdktf.stringToTerraform(struct.path),
        port: cdktf.stringToTerraform(struct.port),
        scheme: cdktf.stringToTerraform(struct.scheme),
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecContainerStartupProbeHttpGetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheme: {
            value: cdktf.stringToHclTerraform(struct.scheme),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        http_header: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerStartupProbeHttpGetOutputReference extends cdktf.ComplexObject {
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
        if (this._host !== undefined) {
            hasAnyValues = true;
            internalValueResult.host = this._host;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._scheme !== undefined) {
            hasAnyValues = true;
            internalValueResult.scheme = this._scheme;
        }
        if (this._httpHeader?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpHeader = this._httpHeader?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._host = undefined;
            this._path = undefined;
            this._port = undefined;
            this._scheme = undefined;
            this._httpHeader.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._host = value.host;
            this._path = value.path;
            this._port = value.port;
            this._scheme = value.scheme;
            this._httpHeader.internalValue = value.httpHeader;
        }
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this.getStringAttribute('host');
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // path - computed: false, optional: true, required: false
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    resetPath() {
        this._path = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // port - computed: false, optional: true, required: false
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    resetPort() {
        this._port = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // scheme - computed: false, optional: true, required: false
    _scheme;
    get scheme() {
        return this.getStringAttribute('scheme');
    }
    set scheme(value) {
        this._scheme = value;
    }
    resetScheme() {
        this._scheme = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schemeInput() {
        return this._scheme;
    }
    // http_header - computed: false, optional: true, required: false
    _httpHeader = new DeploymentSpecTemplateSpecContainerStartupProbeHttpGetHttpHeaderList(this, "http_header", false);
    get httpHeader() {
        return this._httpHeader;
    }
    putHttpHeader(value) {
        this._httpHeader.internalValue = value;
    }
    resetHttpHeader() {
        this._httpHeader.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpHeaderInput() {
        return this._httpHeader.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerStartupProbeTcpSocketToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.stringToTerraform(struct.port),
    };
}
export function deploymentSpecTemplateSpecContainerStartupProbeTcpSocketToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerStartupProbeTcpSocketOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
}
export class DeploymentSpecTemplateSpecContainerStartupProbeTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerStartupProbeTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerStartupProbeToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        failure_threshold: cdktf.numberToTerraform(struct.failureThreshold),
        initial_delay_seconds: cdktf.numberToTerraform(struct.initialDelaySeconds),
        period_seconds: cdktf.numberToTerraform(struct.periodSeconds),
        success_threshold: cdktf.numberToTerraform(struct.successThreshold),
        timeout_seconds: cdktf.numberToTerraform(struct.timeoutSeconds),
        exec: deploymentSpecTemplateSpecContainerStartupProbeExecToTerraform(struct.exec),
        grpc: cdktf.listMapper(deploymentSpecTemplateSpecContainerStartupProbeGrpcToTerraform, true)(struct.grpc),
        http_get: deploymentSpecTemplateSpecContainerStartupProbeHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecContainerStartupProbeTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecContainerStartupProbeToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        failure_threshold: {
            value: cdktf.numberToHclTerraform(struct.failureThreshold),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        initial_delay_seconds: {
            value: cdktf.numberToHclTerraform(struct.initialDelaySeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        period_seconds: {
            value: cdktf.numberToHclTerraform(struct.periodSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        success_threshold: {
            value: cdktf.numberToHclTerraform(struct.successThreshold),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        timeout_seconds: {
            value: cdktf.numberToHclTerraform(struct.timeoutSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        exec: {
            value: deploymentSpecTemplateSpecContainerStartupProbeExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerStartupProbeExecList",
        },
        grpc: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerStartupProbeGrpcToHclTerraform, true)(struct.grpc),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerStartupProbeGrpcList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecContainerStartupProbeHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerStartupProbeHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerStartupProbeTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerStartupProbeTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerStartupProbeOutputReference extends cdktf.ComplexObject {
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
        if (this._failureThreshold !== undefined) {
            hasAnyValues = true;
            internalValueResult.failureThreshold = this._failureThreshold;
        }
        if (this._initialDelaySeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.initialDelaySeconds = this._initialDelaySeconds;
        }
        if (this._periodSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.periodSeconds = this._periodSeconds;
        }
        if (this._successThreshold !== undefined) {
            hasAnyValues = true;
            internalValueResult.successThreshold = this._successThreshold;
        }
        if (this._timeoutSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.timeoutSeconds = this._timeoutSeconds;
        }
        if (this._exec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.exec = this._exec?.internalValue;
        }
        if (this._grpc?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.grpc = this._grpc?.internalValue;
        }
        if (this._httpGet?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpGet = this._httpGet?.internalValue;
        }
        if (this._tcpSocket?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.tcpSocket = this._tcpSocket?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._failureThreshold = undefined;
            this._initialDelaySeconds = undefined;
            this._periodSeconds = undefined;
            this._successThreshold = undefined;
            this._timeoutSeconds = undefined;
            this._exec.internalValue = undefined;
            this._grpc.internalValue = undefined;
            this._httpGet.internalValue = undefined;
            this._tcpSocket.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._failureThreshold = value.failureThreshold;
            this._initialDelaySeconds = value.initialDelaySeconds;
            this._periodSeconds = value.periodSeconds;
            this._successThreshold = value.successThreshold;
            this._timeoutSeconds = value.timeoutSeconds;
            this._exec.internalValue = value.exec;
            this._grpc.internalValue = value.grpc;
            this._httpGet.internalValue = value.httpGet;
            this._tcpSocket.internalValue = value.tcpSocket;
        }
    }
    // failure_threshold - computed: false, optional: true, required: false
    _failureThreshold;
    get failureThreshold() {
        return this.getNumberAttribute('failure_threshold');
    }
    set failureThreshold(value) {
        this._failureThreshold = value;
    }
    resetFailureThreshold() {
        this._failureThreshold = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get failureThresholdInput() {
        return this._failureThreshold;
    }
    // initial_delay_seconds - computed: false, optional: true, required: false
    _initialDelaySeconds;
    get initialDelaySeconds() {
        return this.getNumberAttribute('initial_delay_seconds');
    }
    set initialDelaySeconds(value) {
        this._initialDelaySeconds = value;
    }
    resetInitialDelaySeconds() {
        this._initialDelaySeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get initialDelaySecondsInput() {
        return this._initialDelaySeconds;
    }
    // period_seconds - computed: false, optional: true, required: false
    _periodSeconds;
    get periodSeconds() {
        return this.getNumberAttribute('period_seconds');
    }
    set periodSeconds(value) {
        this._periodSeconds = value;
    }
    resetPeriodSeconds() {
        this._periodSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get periodSecondsInput() {
        return this._periodSeconds;
    }
    // success_threshold - computed: false, optional: true, required: false
    _successThreshold;
    get successThreshold() {
        return this.getNumberAttribute('success_threshold');
    }
    set successThreshold(value) {
        this._successThreshold = value;
    }
    resetSuccessThreshold() {
        this._successThreshold = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get successThresholdInput() {
        return this._successThreshold;
    }
    // timeout_seconds - computed: false, optional: true, required: false
    _timeoutSeconds;
    get timeoutSeconds() {
        return this.getNumberAttribute('timeout_seconds');
    }
    set timeoutSeconds(value) {
        this._timeoutSeconds = value;
    }
    resetTimeoutSeconds() {
        this._timeoutSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get timeoutSecondsInput() {
        return this._timeoutSeconds;
    }
    // exec - computed: false, optional: true, required: false
    _exec = new DeploymentSpecTemplateSpecContainerStartupProbeExecOutputReference(this, "exec");
    get exec() {
        return this._exec;
    }
    putExec(value) {
        this._exec.internalValue = value;
    }
    resetExec() {
        this._exec.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec.internalValue;
    }
    // grpc - computed: false, optional: true, required: false
    _grpc = new DeploymentSpecTemplateSpecContainerStartupProbeGrpcList(this, "grpc", false);
    get grpc() {
        return this._grpc;
    }
    putGrpc(value) {
        this._grpc.internalValue = value;
    }
    resetGrpc() {
        this._grpc.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get grpcInput() {
        return this._grpc.internalValue;
    }
    // http_get - computed: false, optional: true, required: false
    _httpGet = new DeploymentSpecTemplateSpecContainerStartupProbeHttpGetOutputReference(this, "http_get");
    get httpGet() {
        return this._httpGet;
    }
    putHttpGet(value) {
        this._httpGet.internalValue = value;
    }
    resetHttpGet() {
        this._httpGet.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpGetInput() {
        return this._httpGet.internalValue;
    }
    // tcp_socket - computed: false, optional: true, required: false
    _tcpSocket = new DeploymentSpecTemplateSpecContainerStartupProbeTcpSocketList(this, "tcp_socket", false);
    get tcpSocket() {
        return this._tcpSocket;
    }
    putTcpSocket(value) {
        this._tcpSocket.internalValue = value;
    }
    resetTcpSocket() {
        this._tcpSocket.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tcpSocketInput() {
        return this._tcpSocket.internalValue;
    }
}
export function deploymentSpecTemplateSpecContainerVolumeDeviceToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        device_path: cdktf.stringToTerraform(struct.devicePath),
        name: cdktf.stringToTerraform(struct.name),
    };
}
export function deploymentSpecTemplateSpecContainerVolumeDeviceToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        device_path: {
            value: cdktf.stringToHclTerraform(struct.devicePath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
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
export class DeploymentSpecTemplateSpecContainerVolumeDeviceOutputReference extends cdktf.ComplexObject {
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
        if (this._devicePath !== undefined) {
            hasAnyValues = true;
            internalValueResult.devicePath = this._devicePath;
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
            this.resolvableValue = undefined;
            this._devicePath = undefined;
            this._name = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._devicePath = value.devicePath;
            this._name = value.name;
        }
    }
    // device_path - computed: false, optional: false, required: true
    _devicePath;
    get devicePath() {
        return this.getStringAttribute('device_path');
    }
    set devicePath(value) {
        this._devicePath = value;
    }
    // Temporarily expose input value. Use with caution.
    get devicePathInput() {
        return this._devicePath;
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
}
export class DeploymentSpecTemplateSpecContainerVolumeDeviceList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerVolumeDeviceOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerVolumeMountToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        mount_path: cdktf.stringToTerraform(struct.mountPath),
        mount_propagation: cdktf.stringToTerraform(struct.mountPropagation),
        name: cdktf.stringToTerraform(struct.name),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        sub_path: cdktf.stringToTerraform(struct.subPath),
        sub_path_expr: cdktf.stringToTerraform(struct.subPathExpr),
    };
}
export function deploymentSpecTemplateSpecContainerVolumeMountToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        mount_path: {
            value: cdktf.stringToHclTerraform(struct.mountPath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        mount_propagation: {
            value: cdktf.stringToHclTerraform(struct.mountPropagation),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        read_only: {
            value: cdktf.booleanToHclTerraform(struct.readOnly),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        sub_path: {
            value: cdktf.stringToHclTerraform(struct.subPath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        sub_path_expr: {
            value: cdktf.stringToHclTerraform(struct.subPathExpr),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerVolumeMountOutputReference extends cdktf.ComplexObject {
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
        if (this._mountPath !== undefined) {
            hasAnyValues = true;
            internalValueResult.mountPath = this._mountPath;
        }
        if (this._mountPropagation !== undefined) {
            hasAnyValues = true;
            internalValueResult.mountPropagation = this._mountPropagation;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._subPath !== undefined) {
            hasAnyValues = true;
            internalValueResult.subPath = this._subPath;
        }
        if (this._subPathExpr !== undefined) {
            hasAnyValues = true;
            internalValueResult.subPathExpr = this._subPathExpr;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._mountPath = undefined;
            this._mountPropagation = undefined;
            this._name = undefined;
            this._readOnly = undefined;
            this._subPath = undefined;
            this._subPathExpr = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._mountPath = value.mountPath;
            this._mountPropagation = value.mountPropagation;
            this._name = value.name;
            this._readOnly = value.readOnly;
            this._subPath = value.subPath;
            this._subPathExpr = value.subPathExpr;
        }
    }
    // mount_path - computed: false, optional: false, required: true
    _mountPath;
    get mountPath() {
        return this.getStringAttribute('mount_path');
    }
    set mountPath(value) {
        this._mountPath = value;
    }
    // Temporarily expose input value. Use with caution.
    get mountPathInput() {
        return this._mountPath;
    }
    // mount_propagation - computed: false, optional: true, required: false
    _mountPropagation;
    get mountPropagation() {
        return this.getStringAttribute('mount_propagation');
    }
    set mountPropagation(value) {
        this._mountPropagation = value;
    }
    resetMountPropagation() {
        this._mountPropagation = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get mountPropagationInput() {
        return this._mountPropagation;
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
    // read_only - computed: false, optional: true, required: false
    _readOnly;
    get readOnly() {
        return this.getBooleanAttribute('read_only');
    }
    set readOnly(value) {
        this._readOnly = value;
    }
    resetReadOnly() {
        this._readOnly = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get readOnlyInput() {
        return this._readOnly;
    }
    // sub_path - computed: false, optional: true, required: false
    _subPath;
    get subPath() {
        return this.getStringAttribute('sub_path');
    }
    set subPath(value) {
        this._subPath = value;
    }
    resetSubPath() {
        this._subPath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get subPathInput() {
        return this._subPath;
    }
    // sub_path_expr - computed: false, optional: true, required: false
    _subPathExpr;
    get subPathExpr() {
        return this.getStringAttribute('sub_path_expr');
    }
    set subPathExpr(value) {
        this._subPathExpr = value;
    }
    resetSubPathExpr() {
        this._subPathExpr = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get subPathExprInput() {
        return this._subPathExpr;
    }
}
export class DeploymentSpecTemplateSpecContainerVolumeMountList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerVolumeMountOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecContainerToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        args: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.args),
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
        image: cdktf.stringToTerraform(struct.image),
        image_pull_policy: cdktf.stringToTerraform(struct.imagePullPolicy),
        name: cdktf.stringToTerraform(struct.name),
        stdin: cdktf.booleanToTerraform(struct.stdin),
        stdin_once: cdktf.booleanToTerraform(struct.stdinOnce),
        termination_message_path: cdktf.stringToTerraform(struct.terminationMessagePath),
        termination_message_policy: cdktf.stringToTerraform(struct.terminationMessagePolicy),
        tty: cdktf.booleanToTerraform(struct.tty),
        working_dir: cdktf.stringToTerraform(struct.workingDir),
        env: cdktf.listMapper(deploymentSpecTemplateSpecContainerEnvToTerraform, true)(struct.env),
        env_from: cdktf.listMapper(deploymentSpecTemplateSpecContainerEnvFromToTerraform, true)(struct.envFrom),
        lifecycle: deploymentSpecTemplateSpecContainerLifecycleToTerraform(struct.lifecycle),
        liveness_probe: deploymentSpecTemplateSpecContainerLivenessProbeToTerraform(struct.livenessProbe),
        port: cdktf.listMapper(deploymentSpecTemplateSpecContainerPortToTerraform, true)(struct.port),
        readiness_probe: deploymentSpecTemplateSpecContainerReadinessProbeToTerraform(struct.readinessProbe),
        resources: deploymentSpecTemplateSpecContainerResourcesToTerraform(struct.resources),
        security_context: deploymentSpecTemplateSpecContainerSecurityContextToTerraform(struct.securityContext),
        startup_probe: deploymentSpecTemplateSpecContainerStartupProbeToTerraform(struct.startupProbe),
        volume_device: cdktf.listMapper(deploymentSpecTemplateSpecContainerVolumeDeviceToTerraform, true)(struct.volumeDevice),
        volume_mount: cdktf.listMapper(deploymentSpecTemplateSpecContainerVolumeMountToTerraform, true)(struct.volumeMount),
    };
}
export function deploymentSpecTemplateSpecContainerToHclTerraform(struct) {
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
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        image: {
            value: cdktf.stringToHclTerraform(struct.image),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        image_pull_policy: {
            value: cdktf.stringToHclTerraform(struct.imagePullPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        stdin: {
            value: cdktf.booleanToHclTerraform(struct.stdin),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        stdin_once: {
            value: cdktf.booleanToHclTerraform(struct.stdinOnce),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        termination_message_path: {
            value: cdktf.stringToHclTerraform(struct.terminationMessagePath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        termination_message_policy: {
            value: cdktf.stringToHclTerraform(struct.terminationMessagePolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        tty: {
            value: cdktf.booleanToHclTerraform(struct.tty),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        working_dir: {
            value: cdktf.stringToHclTerraform(struct.workingDir),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        env: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerEnvToHclTerraform, true)(struct.env),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvList",
        },
        env_from: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerEnvFromToHclTerraform, true)(struct.envFrom),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerEnvFromList",
        },
        lifecycle: {
            value: deploymentSpecTemplateSpecContainerLifecycleToHclTerraform(struct.lifecycle),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLifecycleList",
        },
        liveness_probe: {
            value: deploymentSpecTemplateSpecContainerLivenessProbeToHclTerraform(struct.livenessProbe),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerLivenessProbeList",
        },
        port: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerPortToHclTerraform, true)(struct.port),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerPortList",
        },
        readiness_probe: {
            value: deploymentSpecTemplateSpecContainerReadinessProbeToHclTerraform(struct.readinessProbe),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerReadinessProbeList",
        },
        resources: {
            value: deploymentSpecTemplateSpecContainerResourcesToHclTerraform(struct.resources),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerResourcesList",
        },
        security_context: {
            value: deploymentSpecTemplateSpecContainerSecurityContextToHclTerraform(struct.securityContext),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerSecurityContextList",
        },
        startup_probe: {
            value: deploymentSpecTemplateSpecContainerStartupProbeToHclTerraform(struct.startupProbe),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerStartupProbeList",
        },
        volume_device: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerVolumeDeviceToHclTerraform, true)(struct.volumeDevice),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerVolumeDeviceList",
        },
        volume_mount: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerVolumeMountToHclTerraform, true)(struct.volumeMount),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerVolumeMountList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecContainerOutputReference extends cdktf.ComplexObject {
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
        if (this._args !== undefined) {
            hasAnyValues = true;
            internalValueResult.args = this._args;
        }
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        if (this._image !== undefined) {
            hasAnyValues = true;
            internalValueResult.image = this._image;
        }
        if (this._imagePullPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.imagePullPolicy = this._imagePullPolicy;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._stdin !== undefined) {
            hasAnyValues = true;
            internalValueResult.stdin = this._stdin;
        }
        if (this._stdinOnce !== undefined) {
            hasAnyValues = true;
            internalValueResult.stdinOnce = this._stdinOnce;
        }
        if (this._terminationMessagePath !== undefined) {
            hasAnyValues = true;
            internalValueResult.terminationMessagePath = this._terminationMessagePath;
        }
        if (this._terminationMessagePolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.terminationMessagePolicy = this._terminationMessagePolicy;
        }
        if (this._tty !== undefined) {
            hasAnyValues = true;
            internalValueResult.tty = this._tty;
        }
        if (this._workingDir !== undefined) {
            hasAnyValues = true;
            internalValueResult.workingDir = this._workingDir;
        }
        if (this._env?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.env = this._env?.internalValue;
        }
        if (this._envFrom?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.envFrom = this._envFrom?.internalValue;
        }
        if (this._lifecycle?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.lifecycle = this._lifecycle?.internalValue;
        }
        if (this._livenessProbe?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.livenessProbe = this._livenessProbe?.internalValue;
        }
        if (this._port?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port?.internalValue;
        }
        if (this._readinessProbe?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.readinessProbe = this._readinessProbe?.internalValue;
        }
        if (this._resources?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.resources = this._resources?.internalValue;
        }
        if (this._securityContext?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.securityContext = this._securityContext?.internalValue;
        }
        if (this._startupProbe?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.startupProbe = this._startupProbe?.internalValue;
        }
        if (this._volumeDevice?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeDevice = this._volumeDevice?.internalValue;
        }
        if (this._volumeMount?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeMount = this._volumeMount?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._args = undefined;
            this._command = undefined;
            this._image = undefined;
            this._imagePullPolicy = undefined;
            this._name = undefined;
            this._stdin = undefined;
            this._stdinOnce = undefined;
            this._terminationMessagePath = undefined;
            this._terminationMessagePolicy = undefined;
            this._tty = undefined;
            this._workingDir = undefined;
            this._env.internalValue = undefined;
            this._envFrom.internalValue = undefined;
            this._lifecycle.internalValue = undefined;
            this._livenessProbe.internalValue = undefined;
            this._port.internalValue = undefined;
            this._readinessProbe.internalValue = undefined;
            this._resources.internalValue = undefined;
            this._securityContext.internalValue = undefined;
            this._startupProbe.internalValue = undefined;
            this._volumeDevice.internalValue = undefined;
            this._volumeMount.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._args = value.args;
            this._command = value.command;
            this._image = value.image;
            this._imagePullPolicy = value.imagePullPolicy;
            this._name = value.name;
            this._stdin = value.stdin;
            this._stdinOnce = value.stdinOnce;
            this._terminationMessagePath = value.terminationMessagePath;
            this._terminationMessagePolicy = value.terminationMessagePolicy;
            this._tty = value.tty;
            this._workingDir = value.workingDir;
            this._env.internalValue = value.env;
            this._envFrom.internalValue = value.envFrom;
            this._lifecycle.internalValue = value.lifecycle;
            this._livenessProbe.internalValue = value.livenessProbe;
            this._port.internalValue = value.port;
            this._readinessProbe.internalValue = value.readinessProbe;
            this._resources.internalValue = value.resources;
            this._securityContext.internalValue = value.securityContext;
            this._startupProbe.internalValue = value.startupProbe;
            this._volumeDevice.internalValue = value.volumeDevice;
            this._volumeMount.internalValue = value.volumeMount;
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
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
    // image - computed: false, optional: true, required: false
    _image;
    get image() {
        return this.getStringAttribute('image');
    }
    set image(value) {
        this._image = value;
    }
    resetImage() {
        this._image = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get imageInput() {
        return this._image;
    }
    // image_pull_policy - computed: true, optional: true, required: false
    _imagePullPolicy;
    get imagePullPolicy() {
        return this.getStringAttribute('image_pull_policy');
    }
    set imagePullPolicy(value) {
        this._imagePullPolicy = value;
    }
    resetImagePullPolicy() {
        this._imagePullPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get imagePullPolicyInput() {
        return this._imagePullPolicy;
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
    // stdin - computed: false, optional: true, required: false
    _stdin;
    get stdin() {
        return this.getBooleanAttribute('stdin');
    }
    set stdin(value) {
        this._stdin = value;
    }
    resetStdin() {
        this._stdin = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get stdinInput() {
        return this._stdin;
    }
    // stdin_once - computed: false, optional: true, required: false
    _stdinOnce;
    get stdinOnce() {
        return this.getBooleanAttribute('stdin_once');
    }
    set stdinOnce(value) {
        this._stdinOnce = value;
    }
    resetStdinOnce() {
        this._stdinOnce = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get stdinOnceInput() {
        return this._stdinOnce;
    }
    // termination_message_path - computed: false, optional: true, required: false
    _terminationMessagePath;
    get terminationMessagePath() {
        return this.getStringAttribute('termination_message_path');
    }
    set terminationMessagePath(value) {
        this._terminationMessagePath = value;
    }
    resetTerminationMessagePath() {
        this._terminationMessagePath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get terminationMessagePathInput() {
        return this._terminationMessagePath;
    }
    // termination_message_policy - computed: true, optional: true, required: false
    _terminationMessagePolicy;
    get terminationMessagePolicy() {
        return this.getStringAttribute('termination_message_policy');
    }
    set terminationMessagePolicy(value) {
        this._terminationMessagePolicy = value;
    }
    resetTerminationMessagePolicy() {
        this._terminationMessagePolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get terminationMessagePolicyInput() {
        return this._terminationMessagePolicy;
    }
    // tty - computed: false, optional: true, required: false
    _tty;
    get tty() {
        return this.getBooleanAttribute('tty');
    }
    set tty(value) {
        this._tty = value;
    }
    resetTty() {
        this._tty = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get ttyInput() {
        return this._tty;
    }
    // working_dir - computed: false, optional: true, required: false
    _workingDir;
    get workingDir() {
        return this.getStringAttribute('working_dir');
    }
    set workingDir(value) {
        this._workingDir = value;
    }
    resetWorkingDir() {
        this._workingDir = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get workingDirInput() {
        return this._workingDir;
    }
    // env - computed: false, optional: true, required: false
    _env = new DeploymentSpecTemplateSpecContainerEnvList(this, "env", false);
    get env() {
        return this._env;
    }
    putEnv(value) {
        this._env.internalValue = value;
    }
    resetEnv() {
        this._env.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get envInput() {
        return this._env.internalValue;
    }
    // env_from - computed: false, optional: true, required: false
    _envFrom = new DeploymentSpecTemplateSpecContainerEnvFromList(this, "env_from", false);
    get envFrom() {
        return this._envFrom;
    }
    putEnvFrom(value) {
        this._envFrom.internalValue = value;
    }
    resetEnvFrom() {
        this._envFrom.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get envFromInput() {
        return this._envFrom.internalValue;
    }
    // lifecycle - computed: false, optional: true, required: false
    _lifecycle = new DeploymentSpecTemplateSpecContainerLifecycleOutputReference(this, "lifecycle");
    get lifecycle() {
        return this._lifecycle;
    }
    putLifecycle(value) {
        this._lifecycle.internalValue = value;
    }
    resetLifecycle() {
        this._lifecycle.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get lifecycleInput() {
        return this._lifecycle.internalValue;
    }
    // liveness_probe - computed: false, optional: true, required: false
    _livenessProbe = new DeploymentSpecTemplateSpecContainerLivenessProbeOutputReference(this, "liveness_probe");
    get livenessProbe() {
        return this._livenessProbe;
    }
    putLivenessProbe(value) {
        this._livenessProbe.internalValue = value;
    }
    resetLivenessProbe() {
        this._livenessProbe.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get livenessProbeInput() {
        return this._livenessProbe.internalValue;
    }
    // port - computed: false, optional: true, required: false
    _port = new DeploymentSpecTemplateSpecContainerPortList(this, "port", false);
    get port() {
        return this._port;
    }
    putPort(value) {
        this._port.internalValue = value;
    }
    resetPort() {
        this._port.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port.internalValue;
    }
    // readiness_probe - computed: false, optional: true, required: false
    _readinessProbe = new DeploymentSpecTemplateSpecContainerReadinessProbeOutputReference(this, "readiness_probe");
    get readinessProbe() {
        return this._readinessProbe;
    }
    putReadinessProbe(value) {
        this._readinessProbe.internalValue = value;
    }
    resetReadinessProbe() {
        this._readinessProbe.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get readinessProbeInput() {
        return this._readinessProbe.internalValue;
    }
    // resources - computed: false, optional: true, required: false
    _resources = new DeploymentSpecTemplateSpecContainerResourcesOutputReference(this, "resources");
    get resources() {
        return this._resources;
    }
    putResources(value) {
        this._resources.internalValue = value;
    }
    resetResources() {
        this._resources.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get resourcesInput() {
        return this._resources.internalValue;
    }
    // security_context - computed: false, optional: true, required: false
    _securityContext = new DeploymentSpecTemplateSpecContainerSecurityContextOutputReference(this, "security_context");
    get securityContext() {
        return this._securityContext;
    }
    putSecurityContext(value) {
        this._securityContext.internalValue = value;
    }
    resetSecurityContext() {
        this._securityContext.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get securityContextInput() {
        return this._securityContext.internalValue;
    }
    // startup_probe - computed: false, optional: true, required: false
    _startupProbe = new DeploymentSpecTemplateSpecContainerStartupProbeOutputReference(this, "startup_probe");
    get startupProbe() {
        return this._startupProbe;
    }
    putStartupProbe(value) {
        this._startupProbe.internalValue = value;
    }
    resetStartupProbe() {
        this._startupProbe.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get startupProbeInput() {
        return this._startupProbe.internalValue;
    }
    // volume_device - computed: false, optional: true, required: false
    _volumeDevice = new DeploymentSpecTemplateSpecContainerVolumeDeviceList(this, "volume_device", false);
    get volumeDevice() {
        return this._volumeDevice;
    }
    putVolumeDevice(value) {
        this._volumeDevice.internalValue = value;
    }
    resetVolumeDevice() {
        this._volumeDevice.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get volumeDeviceInput() {
        return this._volumeDevice.internalValue;
    }
    // volume_mount - computed: false, optional: true, required: false
    _volumeMount = new DeploymentSpecTemplateSpecContainerVolumeMountList(this, "volume_mount", false);
    get volumeMount() {
        return this._volumeMount;
    }
    putVolumeMount(value) {
        this._volumeMount.internalValue = value;
    }
    resetVolumeMount() {
        this._volumeMount.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get volumeMountInput() {
        return this._volumeMount.internalValue;
    }
}
export class DeploymentSpecTemplateSpecContainerList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecContainerOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecDnsConfigOptionToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecDnsConfigOptionToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecDnsConfigOptionOutputReference extends cdktf.ComplexObject {
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecDnsConfigOptionList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecDnsConfigOptionOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecDnsConfigToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        nameservers: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.nameservers),
        searches: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.searches),
        option: cdktf.listMapper(deploymentSpecTemplateSpecDnsConfigOptionToTerraform, true)(struct.option),
    };
}
export function deploymentSpecTemplateSpecDnsConfigToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        nameservers: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.nameservers),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        searches: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.searches),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        option: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecDnsConfigOptionToHclTerraform, true)(struct.option),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecDnsConfigOptionList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecDnsConfigOutputReference extends cdktf.ComplexObject {
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
        if (this._nameservers !== undefined) {
            hasAnyValues = true;
            internalValueResult.nameservers = this._nameservers;
        }
        if (this._searches !== undefined) {
            hasAnyValues = true;
            internalValueResult.searches = this._searches;
        }
        if (this._option?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.option = this._option?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._nameservers = undefined;
            this._searches = undefined;
            this._option.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._nameservers = value.nameservers;
            this._searches = value.searches;
            this._option.internalValue = value.option;
        }
    }
    // nameservers - computed: false, optional: true, required: false
    _nameservers;
    get nameservers() {
        return this.getListAttribute('nameservers');
    }
    set nameservers(value) {
        this._nameservers = value;
    }
    resetNameservers() {
        this._nameservers = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nameserversInput() {
        return this._nameservers;
    }
    // searches - computed: false, optional: true, required: false
    _searches;
    get searches() {
        return this.getListAttribute('searches');
    }
    set searches(value) {
        this._searches = value;
    }
    resetSearches() {
        this._searches = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get searchesInput() {
        return this._searches;
    }
    // option - computed: false, optional: true, required: false
    _option = new DeploymentSpecTemplateSpecDnsConfigOptionList(this, "option", false);
    get option() {
        return this._option;
    }
    putOption(value) {
        this._option.internalValue = value;
    }
    resetOption() {
        this._option.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionInput() {
        return this._option.internalValue;
    }
}
export function deploymentSpecTemplateSpecHostAliasesToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        hostnames: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.hostnames),
        ip: cdktf.stringToTerraform(struct.ip),
    };
}
export function deploymentSpecTemplateSpecHostAliasesToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        hostnames: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.hostnames),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        ip: {
            value: cdktf.stringToHclTerraform(struct.ip),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecHostAliasesOutputReference extends cdktf.ComplexObject {
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
        if (this._hostnames !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostnames = this._hostnames;
        }
        if (this._ip !== undefined) {
            hasAnyValues = true;
            internalValueResult.ip = this._ip;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._hostnames = undefined;
            this._ip = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._hostnames = value.hostnames;
            this._ip = value.ip;
        }
    }
    // hostnames - computed: false, optional: false, required: true
    _hostnames;
    get hostnames() {
        return this.getListAttribute('hostnames');
    }
    set hostnames(value) {
        this._hostnames = value;
    }
    // Temporarily expose input value. Use with caution.
    get hostnamesInput() {
        return this._hostnames;
    }
    // ip - computed: false, optional: false, required: true
    _ip;
    get ip() {
        return this.getStringAttribute('ip');
    }
    set ip(value) {
        this._ip = value;
    }
    // Temporarily expose input value. Use with caution.
    get ipInput() {
        return this._ip;
    }
}
export class DeploymentSpecTemplateSpecHostAliasesList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecHostAliasesOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecImagePullSecretsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
    };
}
export function deploymentSpecTemplateSpecImagePullSecretsToHclTerraform(struct) {
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecImagePullSecretsOutputReference extends cdktf.ComplexObject {
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
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._name = value.name;
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
}
export class DeploymentSpecTemplateSpecImagePullSecretsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecImagePullSecretsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromConfigMapKeyRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromConfigMapKeyRefToHclTerraform(struct) {
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
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvValueFromConfigMapKeyRefOutputReference extends cdktf.ComplexObject {
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
        if (this._key !== undefined) {
            hasAnyValues = true;
            internalValueResult.key = this._key;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._key = undefined;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._key = value.key;
            this._name = value.name;
            this._optional = value.optional;
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
    // name - computed: false, optional: true, required: false
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromFieldRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        api_version: cdktf.stringToTerraform(struct.apiVersion),
        field_path: cdktf.stringToTerraform(struct.fieldPath),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromFieldRefToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        api_version: {
            value: cdktf.stringToHclTerraform(struct.apiVersion),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        field_path: {
            value: cdktf.stringToHclTerraform(struct.fieldPath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvValueFromFieldRefOutputReference extends cdktf.ComplexObject {
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
        if (this._apiVersion !== undefined) {
            hasAnyValues = true;
            internalValueResult.apiVersion = this._apiVersion;
        }
        if (this._fieldPath !== undefined) {
            hasAnyValues = true;
            internalValueResult.fieldPath = this._fieldPath;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._apiVersion = undefined;
            this._fieldPath = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._apiVersion = value.apiVersion;
            this._fieldPath = value.fieldPath;
        }
    }
    // api_version - computed: false, optional: true, required: false
    _apiVersion;
    get apiVersion() {
        return this.getStringAttribute('api_version');
    }
    set apiVersion(value) {
        this._apiVersion = value;
    }
    resetApiVersion() {
        this._apiVersion = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get apiVersionInput() {
        return this._apiVersion;
    }
    // field_path - computed: false, optional: true, required: false
    _fieldPath;
    get fieldPath() {
        return this.getStringAttribute('field_path');
    }
    set fieldPath(value) {
        this._fieldPath = value;
    }
    resetFieldPath() {
        this._fieldPath = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fieldPathInput() {
        return this._fieldPath;
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromResourceFieldRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        container_name: cdktf.stringToTerraform(struct.containerName),
        divisor: cdktf.stringToTerraform(struct.divisor),
        resource: cdktf.stringToTerraform(struct.resource),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromResourceFieldRefToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        container_name: {
            value: cdktf.stringToHclTerraform(struct.containerName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        divisor: {
            value: cdktf.stringToHclTerraform(struct.divisor),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        resource: {
            value: cdktf.stringToHclTerraform(struct.resource),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvValueFromResourceFieldRefOutputReference extends cdktf.ComplexObject {
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
        if (this._containerName !== undefined) {
            hasAnyValues = true;
            internalValueResult.containerName = this._containerName;
        }
        if (this._divisor !== undefined) {
            hasAnyValues = true;
            internalValueResult.divisor = this._divisor;
        }
        if (this._resource !== undefined) {
            hasAnyValues = true;
            internalValueResult.resource = this._resource;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._containerName = undefined;
            this._divisor = undefined;
            this._resource = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._containerName = value.containerName;
            this._divisor = value.divisor;
            this._resource = value.resource;
        }
    }
    // container_name - computed: false, optional: true, required: false
    _containerName;
    get containerName() {
        return this.getStringAttribute('container_name');
    }
    set containerName(value) {
        this._containerName = value;
    }
    resetContainerName() {
        this._containerName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get containerNameInput() {
        return this._containerName;
    }
    // divisor - computed: false, optional: true, required: false
    _divisor;
    get divisor() {
        return this.getStringAttribute('divisor');
    }
    set divisor(value) {
        this._divisor = value;
    }
    resetDivisor() {
        this._divisor = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get divisorInput() {
        return this._divisor;
    }
    // resource - computed: false, optional: false, required: true
    _resource;
    get resource() {
        return this.getStringAttribute('resource');
    }
    set resource(value) {
        this._resource = value;
    }
    // Temporarily expose input value. Use with caution.
    get resourceInput() {
        return this._resource;
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromSecretKeyRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromSecretKeyRefToHclTerraform(struct) {
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
        name: {
            value: cdktf.stringToHclTerraform(struct.name),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvValueFromSecretKeyRefOutputReference extends cdktf.ComplexObject {
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
        if (this._key !== undefined) {
            hasAnyValues = true;
            internalValueResult.key = this._key;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._key = undefined;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._key = value.key;
            this._name = value.name;
            this._optional = value.optional;
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
    // name - computed: false, optional: true, required: false
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        config_map_key_ref: deploymentSpecTemplateSpecInitContainerEnvValueFromConfigMapKeyRefToTerraform(struct.configMapKeyRef),
        field_ref: deploymentSpecTemplateSpecInitContainerEnvValueFromFieldRefToTerraform(struct.fieldRef),
        resource_field_ref: deploymentSpecTemplateSpecInitContainerEnvValueFromResourceFieldRefToTerraform(struct.resourceFieldRef),
        secret_key_ref: deploymentSpecTemplateSpecInitContainerEnvValueFromSecretKeyRefToTerraform(struct.secretKeyRef),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvValueFromToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        config_map_key_ref: {
            value: deploymentSpecTemplateSpecInitContainerEnvValueFromConfigMapKeyRefToHclTerraform(struct.configMapKeyRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvValueFromConfigMapKeyRefList",
        },
        field_ref: {
            value: deploymentSpecTemplateSpecInitContainerEnvValueFromFieldRefToHclTerraform(struct.fieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvValueFromFieldRefList",
        },
        resource_field_ref: {
            value: deploymentSpecTemplateSpecInitContainerEnvValueFromResourceFieldRefToHclTerraform(struct.resourceFieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvValueFromResourceFieldRefList",
        },
        secret_key_ref: {
            value: deploymentSpecTemplateSpecInitContainerEnvValueFromSecretKeyRefToHclTerraform(struct.secretKeyRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvValueFromSecretKeyRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvValueFromOutputReference extends cdktf.ComplexObject {
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
        if (this._configMapKeyRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.configMapKeyRef = this._configMapKeyRef?.internalValue;
        }
        if (this._fieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.fieldRef = this._fieldRef?.internalValue;
        }
        if (this._resourceFieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.resourceFieldRef = this._resourceFieldRef?.internalValue;
        }
        if (this._secretKeyRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretKeyRef = this._secretKeyRef?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._configMapKeyRef.internalValue = undefined;
            this._fieldRef.internalValue = undefined;
            this._resourceFieldRef.internalValue = undefined;
            this._secretKeyRef.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._configMapKeyRef.internalValue = value.configMapKeyRef;
            this._fieldRef.internalValue = value.fieldRef;
            this._resourceFieldRef.internalValue = value.resourceFieldRef;
            this._secretKeyRef.internalValue = value.secretKeyRef;
        }
    }
    // config_map_key_ref - computed: false, optional: true, required: false
    _configMapKeyRef = new DeploymentSpecTemplateSpecInitContainerEnvValueFromConfigMapKeyRefOutputReference(this, "config_map_key_ref");
    get configMapKeyRef() {
        return this._configMapKeyRef;
    }
    putConfigMapKeyRef(value) {
        this._configMapKeyRef.internalValue = value;
    }
    resetConfigMapKeyRef() {
        this._configMapKeyRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configMapKeyRefInput() {
        return this._configMapKeyRef.internalValue;
    }
    // field_ref - computed: false, optional: true, required: false
    _fieldRef = new DeploymentSpecTemplateSpecInitContainerEnvValueFromFieldRefOutputReference(this, "field_ref");
    get fieldRef() {
        return this._fieldRef;
    }
    putFieldRef(value) {
        this._fieldRef.internalValue = value;
    }
    resetFieldRef() {
        this._fieldRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fieldRefInput() {
        return this._fieldRef.internalValue;
    }
    // resource_field_ref - computed: false, optional: true, required: false
    _resourceFieldRef = new DeploymentSpecTemplateSpecInitContainerEnvValueFromResourceFieldRefOutputReference(this, "resource_field_ref");
    get resourceFieldRef() {
        return this._resourceFieldRef;
    }
    putResourceFieldRef(value) {
        this._resourceFieldRef.internalValue = value;
    }
    resetResourceFieldRef() {
        this._resourceFieldRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get resourceFieldRefInput() {
        return this._resourceFieldRef.internalValue;
    }
    // secret_key_ref - computed: false, optional: true, required: false
    _secretKeyRef = new DeploymentSpecTemplateSpecInitContainerEnvValueFromSecretKeyRefOutputReference(this, "secret_key_ref");
    get secretKeyRef() {
        return this._secretKeyRef;
    }
    putSecretKeyRef(value) {
        this._secretKeyRef.internalValue = value;
    }
    resetSecretKeyRef() {
        this._secretKeyRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretKeyRefInput() {
        return this._secretKeyRef.internalValue;
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
        value_from: deploymentSpecTemplateSpecInitContainerEnvValueFromToTerraform(struct.valueFrom),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        value_from: {
            value: deploymentSpecTemplateSpecInitContainerEnvValueFromToHclTerraform(struct.valueFrom),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvValueFromList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvOutputReference extends cdktf.ComplexObject {
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
        if (this._valueFrom?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.valueFrom = this._valueFrom?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._value = undefined;
            this._valueFrom.internalValue = undefined;
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
            this._valueFrom.internalValue = value.valueFrom;
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
    // value_from - computed: false, optional: true, required: false
    _valueFrom = new DeploymentSpecTemplateSpecInitContainerEnvValueFromOutputReference(this, "value_from");
    get valueFrom() {
        return this._valueFrom;
    }
    putValueFrom(value) {
        this._valueFrom.internalValue = value;
    }
    resetValueFrom() {
        this._valueFrom.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueFromInput() {
        return this._valueFrom.internalValue;
    }
}
export class DeploymentSpecTemplateSpecInitContainerEnvList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerEnvOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvFromConfigMapRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvFromConfigMapRefToHclTerraform(struct) {
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
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvFromConfigMapRefOutputReference extends cdktf.ComplexObject {
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
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
            this._optional = value.optional;
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvFromSecretRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvFromSecretRefToHclTerraform(struct) {
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
        optional: {
            value: cdktf.booleanToHclTerraform(struct.optional),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvFromSecretRefOutputReference extends cdktf.ComplexObject {
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
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
            this._optional = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
            this._optional = value.optional;
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
    // optional - computed: false, optional: true, required: false
    _optional;
    get optional() {
        return this.getBooleanAttribute('optional');
    }
    set optional(value) {
        this._optional = value;
    }
    resetOptional() {
        this._optional = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionalInput() {
        return this._optional;
    }
}
export function deploymentSpecTemplateSpecInitContainerEnvFromToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        prefix: cdktf.stringToTerraform(struct.prefix),
        config_map_ref: deploymentSpecTemplateSpecInitContainerEnvFromConfigMapRefToTerraform(struct.configMapRef),
        secret_ref: deploymentSpecTemplateSpecInitContainerEnvFromSecretRefToTerraform(struct.secretRef),
    };
}
export function deploymentSpecTemplateSpecInitContainerEnvFromToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        prefix: {
            value: cdktf.stringToHclTerraform(struct.prefix),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        config_map_ref: {
            value: deploymentSpecTemplateSpecInitContainerEnvFromConfigMapRefToHclTerraform(struct.configMapRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvFromConfigMapRefList",
        },
        secret_ref: {
            value: deploymentSpecTemplateSpecInitContainerEnvFromSecretRefToHclTerraform(struct.secretRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvFromSecretRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerEnvFromOutputReference extends cdktf.ComplexObject {
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
        if (this._prefix !== undefined) {
            hasAnyValues = true;
            internalValueResult.prefix = this._prefix;
        }
        if (this._configMapRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.configMapRef = this._configMapRef?.internalValue;
        }
        if (this._secretRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretRef = this._secretRef?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._prefix = undefined;
            this._configMapRef.internalValue = undefined;
            this._secretRef.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._prefix = value.prefix;
            this._configMapRef.internalValue = value.configMapRef;
            this._secretRef.internalValue = value.secretRef;
        }
    }
    // prefix - computed: false, optional: true, required: false
    _prefix;
    get prefix() {
        return this.getStringAttribute('prefix');
    }
    set prefix(value) {
        this._prefix = value;
    }
    resetPrefix() {
        this._prefix = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get prefixInput() {
        return this._prefix;
    }
    // config_map_ref - computed: false, optional: true, required: false
    _configMapRef = new DeploymentSpecTemplateSpecInitContainerEnvFromConfigMapRefOutputReference(this, "config_map_ref");
    get configMapRef() {
        return this._configMapRef;
    }
    putConfigMapRef(value) {
        this._configMapRef.internalValue = value;
    }
    resetConfigMapRef() {
        this._configMapRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configMapRefInput() {
        return this._configMapRef.internalValue;
    }
    // secret_ref - computed: false, optional: true, required: false
    _secretRef = new DeploymentSpecTemplateSpecInitContainerEnvFromSecretRefOutputReference(this, "secret_ref");
    get secretRef() {
        return this._secretRef;
    }
    putSecretRef(value) {
        this._secretRef.internalValue = value;
    }
    resetSecretRef() {
        this._secretRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretRefInput() {
        return this._secretRef.internalValue;
    }
}
export class DeploymentSpecTemplateSpecInitContainerEnvFromList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerEnvFromOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
    // name - computed: false, optional: true, required: false
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        host: cdktf.stringToTerraform(struct.host),
        path: cdktf.stringToTerraform(struct.path),
        port: cdktf.stringToTerraform(struct.port),
        scheme: cdktf.stringToTerraform(struct.scheme),
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheme: {
            value: cdktf.stringToHclTerraform(struct.scheme),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        http_header: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetOutputReference extends cdktf.ComplexObject {
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
        if (this._host !== undefined) {
            hasAnyValues = true;
            internalValueResult.host = this._host;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._scheme !== undefined) {
            hasAnyValues = true;
            internalValueResult.scheme = this._scheme;
        }
        if (this._httpHeader?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpHeader = this._httpHeader?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._host = undefined;
            this._path = undefined;
            this._port = undefined;
            this._scheme = undefined;
            this._httpHeader.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._host = value.host;
            this._path = value.path;
            this._port = value.port;
            this._scheme = value.scheme;
            this._httpHeader.internalValue = value.httpHeader;
        }
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this.getStringAttribute('host');
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // path - computed: false, optional: true, required: false
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    resetPath() {
        this._path = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // port - computed: false, optional: true, required: false
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    resetPort() {
        this._port = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // scheme - computed: false, optional: true, required: false
    _scheme;
    get scheme() {
        return this.getStringAttribute('scheme');
    }
    set scheme(value) {
        this._scheme = value;
    }
    resetScheme() {
        this._scheme = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schemeInput() {
        return this._scheme;
    }
    // http_header - computed: false, optional: true, required: false
    _httpHeader = new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetHttpHeaderList(this, "http_header", false);
    get httpHeader() {
        return this._httpHeader;
    }
    putHttpHeader(value) {
        this._httpHeader.internalValue = value;
    }
    resetHttpHeader() {
        this._httpHeader.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpHeaderInput() {
        return this._httpHeader.internalValue;
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.stringToTerraform(struct.port),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        exec: deploymentSpecTemplateSpecInitContainerLifecyclePostStartExecToTerraform(struct.exec),
        http_get: deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePostStartToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        exec: {
            value: deploymentSpecTemplateSpecInitContainerLifecyclePostStartExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePostStartExecList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartOutputReference extends cdktf.ComplexObject {
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
        if (this._exec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.exec = this._exec?.internalValue;
        }
        if (this._httpGet?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpGet = this._httpGet?.internalValue;
        }
        if (this._tcpSocket?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.tcpSocket = this._tcpSocket?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._exec.internalValue = undefined;
            this._httpGet.internalValue = undefined;
            this._tcpSocket.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._exec.internalValue = value.exec;
            this._httpGet.internalValue = value.httpGet;
            this._tcpSocket.internalValue = value.tcpSocket;
        }
    }
    // exec - computed: false, optional: true, required: false
    _exec = new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartExecOutputReference(this, "exec");
    get exec() {
        return this._exec;
    }
    putExec(value) {
        this._exec.internalValue = value;
    }
    resetExec() {
        this._exec.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec.internalValue;
    }
    // http_get - computed: false, optional: true, required: false
    _httpGet = new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartHttpGetOutputReference(this, "http_get");
    get httpGet() {
        return this._httpGet;
    }
    putHttpGet(value) {
        this._httpGet.internalValue = value;
    }
    resetHttpGet() {
        this._httpGet.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpGetInput() {
        return this._httpGet.internalValue;
    }
    // tcp_socket - computed: false, optional: true, required: false
    _tcpSocket = new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartTcpSocketList(this, "tcp_socket", false);
    get tcpSocket() {
        return this._tcpSocket;
    }
    putTcpSocket(value) {
        this._tcpSocket.internalValue = value;
    }
    resetTcpSocket() {
        this._tcpSocket.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tcpSocketInput() {
        return this._tcpSocket.internalValue;
    }
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePostStartList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderToHclTerraform(struct) {
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
            value: cdktf.stringToHclTerraform(struct.value),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
    // name - computed: false, optional: true, required: false
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
    // value - computed: false, optional: true, required: false
    _value;
    get value() {
        return this.getStringAttribute('value');
    }
    set value(value) {
        this._value = value;
    }
    resetValue() {
        this._value = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get valueInput() {
        return this._value;
    }
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        host: cdktf.stringToTerraform(struct.host),
        path: cdktf.stringToTerraform(struct.path),
        port: cdktf.stringToTerraform(struct.port),
        scheme: cdktf.stringToTerraform(struct.scheme),
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        host: {
            value: cdktf.stringToHclTerraform(struct.host),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheme: {
            value: cdktf.stringToHclTerraform(struct.scheme),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        http_header: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetOutputReference extends cdktf.ComplexObject {
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
        if (this._host !== undefined) {
            hasAnyValues = true;
            internalValueResult.host = this._host;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._scheme !== undefined) {
            hasAnyValues = true;
            internalValueResult.scheme = this._scheme;
        }
        if (this._httpHeader?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpHeader = this._httpHeader?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._host = undefined;
            this._path = undefined;
            this._port = undefined;
            this._scheme = undefined;
            this._httpHeader.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._host = value.host;
            this._path = value.path;
            this._port = value.port;
            this._scheme = value.scheme;
            this._httpHeader.internalValue = value.httpHeader;
        }
    }
    // host - computed: false, optional: true, required: false
    _host;
    get host() {
        return this.getStringAttribute('host');
    }
    set host(value) {
        this._host = value;
    }
    resetHost() {
        this._host = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostInput() {
        return this._host;
    }
    // path - computed: false, optional: true, required: false
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    resetPath() {
        this._path = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // port - computed: false, optional: true, required: false
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    resetPort() {
        this._port = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // scheme - computed: false, optional: true, required: false
    _scheme;
    get scheme() {
        return this.getStringAttribute('scheme');
    }
    set scheme(value) {
        this._scheme = value;
    }
    resetScheme() {
        this._scheme = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schemeInput() {
        return this._scheme;
    }
    // http_header - computed: false, optional: true, required: false
    _httpHeader = new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetHttpHeaderList(this, "http_header", false);
    get httpHeader() {
        return this._httpHeader;
    }
    putHttpHeader(value) {
        this._httpHeader.internalValue = value;
    }
    resetHttpHeader() {
        this._httpHeader.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpHeaderInput() {
        return this._httpHeader.internalValue;
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.stringToTerraform(struct.port),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.stringToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getStringAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        exec: deploymentSpecTemplateSpecInitContainerLifecyclePreStopExecToTerraform(struct.exec),
        http_get: deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecyclePreStopToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        exec: {
            value: deploymentSpecTemplateSpecInitContainerLifecyclePreStopExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePreStopExecList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopOutputReference extends cdktf.ComplexObject {
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
        if (this._exec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.exec = this._exec?.internalValue;
        }
        if (this._httpGet?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.httpGet = this._httpGet?.internalValue;
        }
        if (this._tcpSocket?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.tcpSocket = this._tcpSocket?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._exec.internalValue = undefined;
            this._httpGet.internalValue = undefined;
            this._tcpSocket.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._exec.internalValue = value.exec;
            this._httpGet.internalValue = value.httpGet;
            this._tcpSocket.internalValue = value.tcpSocket;
        }
    }
    // exec - computed: false, optional: true, required: false
    _exec = new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopExecOutputReference(this, "exec");
    get exec() {
        return this._exec;
    }
    putExec(value) {
        this._exec.internalValue = value;
    }
    resetExec() {
        this._exec.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get execInput() {
        return this._exec.internalValue;
    }
    // http_get - computed: false, optional: true, required: false
    _httpGet = new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopHttpGetOutputReference(this, "http_get");
    get httpGet() {
        return this._httpGet;
    }
    putHttpGet(value) {
        this._httpGet.internalValue = value;
    }
    resetHttpGet() {
        this._httpGet.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get httpGetInput() {
        return this._httpGet.internalValue;
    }
    // tcp_socket - computed: false, optional: true, required: false
    _tcpSocket = new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopTcpSocketList(this, "tcp_socket", false);
    get tcpSocket() {
        return this._tcpSocket;
    }
    putTcpSocket(value) {
        this._tcpSocket.internalValue = value;
    }
    resetTcpSocket() {
        this._tcpSocket.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tcpSocketInput() {
        return this._tcpSocket.internalValue;
    }
}
export class DeploymentSpecTemplateSpecInitContainerLifecyclePreStopList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLifecycleToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        post_start: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLifecyclePostStartToTerraform, true)(struct.postStart),
        pre_stop: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLifecyclePreStopToTerraform, true)(struct.preStop),
    };
}
export function deploymentSpecTemplateSpecInitContainerLifecycleToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        post_start: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLifecyclePostStartToHclTerraform, true)(struct.postStart),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePostStartList",
        },
        pre_stop: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLifecyclePreStopToHclTerraform, true)(struct.preStop),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecyclePreStopList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLifecycleOutputReference extends cdktf.ComplexObject {
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
        if (this._postStart?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.postStart = this._postStart?.internalValue;
        }
        if (this._preStop?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.preStop = this._preStop?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._postStart.internalValue = undefined;
            this._preStop.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._postStart.internalValue = value.postStart;
            this._preStop.internalValue = value.preStop;
        }
    }
    // post_start - computed: false, optional: true, required: false
    _postStart = new DeploymentSpecTemplateSpecInitContainerLifecyclePostStartList(this, "post_start", false);
    get postStart() {
        return this._postStart;
    }
    putPostStart(value) {
        this._postStart.internalValue = value;
    }
    resetPostStart() {
        this._postStart.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get postStartInput() {
        return this._postStart.internalValue;
    }
    // pre_stop - computed: false, optional: true, required: false
    _preStop = new DeploymentSpecTemplateSpecInitContainerLifecyclePreStopList(this, "pre_stop", false);
    get preStop() {
        return this._preStop;
    }
    putPreStop(value) {
        this._preStop.internalValue = value;
    }
    resetPreStop() {
        this._preStop.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get preStopInput() {
        return this._preStop.internalValue;
    }
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeExecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        command: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.command),
    };
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeExecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        command: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.command),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeExecOutputReference extends cdktf.ComplexObject {
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
        if (this._command !== undefined) {
            hasAnyValues = true;
            internalValueResult.command = this._command;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._command = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._command = value.command;
        }
    }
    // command - computed: false, optional: true, required: false
    _command;
    get command() {
        return this.getListAttribute('command');
    }
    set command(value) {
        this._command = value;
    }
    resetCommand() {
        this._command = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get commandInput() {
        return this._command;
    }
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeGrpcToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        port: cdktf.numberToTerraform(struct.port),
        service: cdktf.stringToTerraform(struct.service),
    };
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeGrpcToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        port: {
            value: cdktf.numberToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        service: {
            value: cdktf.stringToHclTerraform(struct.service),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeGrpcOutputReference extends cdktf.ComplexObject {
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
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._service !== undefined) {
            hasAnyValues = true;
            internalValueResult.service = this._service;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._port = undefined;
            this._service = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._port = value.port;
            this._service = value.service;
        }
    }
    // port - computed: false, optional: false, required: true
    _port;
    get port() {
        return this.getNumberAttribute('port');
    }
    set port(value) {
        this._port = value;
    }
    // Temporarily expose input value. Use with caution.
    get portInput() {
        return this._port;
    }
    // service - computed: false, optional: true, required: false
    _service;
    get service() {
        return this.getStringAttribute('service');
    }
    set service(value) {
        this._service = value;
    }
    resetService() {
        this._service = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get serviceInput() {
        return this._service;
    }
}
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeGrpcList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLivenessProbeGrpcOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
