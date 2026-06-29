// https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service
// generated from terraform resource schema
import * as cdktf from 'cdktf';
export function serviceStatusLoadBalancerIngressToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {};
}
export function serviceStatusLoadBalancerIngressToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {};
    return attrs;
}
export class ServiceStatusLoadBalancerIngressOutputReference extends cdktf.ComplexObject {
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
    // hostname - computed: true, optional: false, required: false
    get hostname() {
        return this.getStringAttribute('hostname');
    }
    // ip - computed: true, optional: false, required: false
    get ip() {
        return this.getStringAttribute('ip');
    }
}
export class ServiceStatusLoadBalancerIngressList extends cdktf.ComplexList {
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
        return new ServiceStatusLoadBalancerIngressOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function serviceStatusLoadBalancerToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {};
}
export function serviceStatusLoadBalancerToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {};
    return attrs;
}
export class ServiceStatusLoadBalancerOutputReference extends cdktf.ComplexObject {
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
    // ingress - computed: true, optional: false, required: false
    _ingress = new ServiceStatusLoadBalancerIngressList(this, "ingress", false);
    get ingress() {
        return this._ingress;
    }
}
export class ServiceStatusLoadBalancerList extends cdktf.ComplexList {
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
        return new ServiceStatusLoadBalancerOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function serviceStatusToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {};
}
export function serviceStatusToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {};
    return attrs;
}
export class ServiceStatusOutputReference extends cdktf.ComplexObject {
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
    // load_balancer - computed: true, optional: false, required: false
    _loadBalancer = new ServiceStatusLoadBalancerList(this, "load_balancer", false);
    get loadBalancer() {
        return this._loadBalancer;
    }
}
export class ServiceStatusList extends cdktf.ComplexList {
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
        return new ServiceStatusOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function serviceMetadataToTerraform(struct) {
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
export function serviceMetadataToHclTerraform(struct) {
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
export class ServiceMetadataOutputReference extends cdktf.ComplexObject {
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
export function serviceSpecPortToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        app_protocol: cdktf.stringToTerraform(struct.appProtocol),
        name: cdktf.stringToTerraform(struct.name),
        node_port: cdktf.numberToTerraform(struct.nodePort),
        port: cdktf.numberToTerraform(struct.port),
        protocol: cdktf.stringToTerraform(struct.protocol),
        target_port: cdktf.stringToTerraform(struct.targetPort),
    };
}
export function serviceSpecPortToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        app_protocol: {
            value: cdktf.stringToHclTerraform(struct.appProtocol),
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
        node_port: {
            value: cdktf.numberToHclTerraform(struct.nodePort),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        port: {
            value: cdktf.numberToHclTerraform(struct.port),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        protocol: {
            value: cdktf.stringToHclTerraform(struct.protocol),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        target_port: {
            value: cdktf.stringToHclTerraform(struct.targetPort),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ServiceSpecPortOutputReference extends cdktf.ComplexObject {
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
        if (this._appProtocol !== undefined) {
            hasAnyValues = true;
            internalValueResult.appProtocol = this._appProtocol;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._nodePort !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodePort = this._nodePort;
        }
        if (this._port !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port;
        }
        if (this._protocol !== undefined) {
            hasAnyValues = true;
            internalValueResult.protocol = this._protocol;
        }
        if (this._targetPort !== undefined) {
            hasAnyValues = true;
            internalValueResult.targetPort = this._targetPort;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._appProtocol = undefined;
            this._name = undefined;
            this._nodePort = undefined;
            this._port = undefined;
            this._protocol = undefined;
            this._targetPort = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._appProtocol = value.appProtocol;
            this._name = value.name;
            this._nodePort = value.nodePort;
            this._port = value.port;
            this._protocol = value.protocol;
            this._targetPort = value.targetPort;
        }
    }
    // app_protocol - computed: false, optional: true, required: false
    _appProtocol;
    get appProtocol() {
        return this.getStringAttribute('app_protocol');
    }
    set appProtocol(value) {
        this._appProtocol = value;
    }
    resetAppProtocol() {
        this._appProtocol = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get appProtocolInput() {
        return this._appProtocol;
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
    // node_port - computed: true, optional: true, required: false
    _nodePort;
    get nodePort() {
        return this.getNumberAttribute('node_port');
    }
    set nodePort(value) {
        this._nodePort = value;
    }
    resetNodePort() {
        this._nodePort = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodePortInput() {
        return this._nodePort;
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
    // target_port - computed: true, optional: true, required: false
    _targetPort;
    get targetPort() {
        return this.getStringAttribute('target_port');
    }
    set targetPort(value) {
        this._targetPort = value;
    }
    resetTargetPort() {
        this._targetPort = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get targetPortInput() {
        return this._targetPort;
    }
}
export class ServiceSpecPortList extends cdktf.ComplexList {
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
        return new ServiceSpecPortOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function serviceSpecSessionAffinityConfigClientIpToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        timeout_seconds: cdktf.numberToTerraform(struct.timeoutSeconds),
    };
}
export function serviceSpecSessionAffinityConfigClientIpToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        timeout_seconds: {
            value: cdktf.numberToHclTerraform(struct.timeoutSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ServiceSpecSessionAffinityConfigClientIpOutputReference extends cdktf.ComplexObject {
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
        if (this._timeoutSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.timeoutSeconds = this._timeoutSeconds;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._timeoutSeconds = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._timeoutSeconds = value.timeoutSeconds;
        }
    }
    // timeout_seconds - computed: true, optional: true, required: false
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
}
export function serviceSpecSessionAffinityConfigToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        client_ip: serviceSpecSessionAffinityConfigClientIpToTerraform(struct.clientIp),
    };
}
export function serviceSpecSessionAffinityConfigToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        client_ip: {
            value: serviceSpecSessionAffinityConfigClientIpToHclTerraform(struct.clientIp),
            isBlock: true,
            type: "list",
            storageClassType: "ServiceSpecSessionAffinityConfigClientIpList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ServiceSpecSessionAffinityConfigOutputReference extends cdktf.ComplexObject {
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
        if (this._clientIp?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.clientIp = this._clientIp?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._clientIp.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._clientIp.internalValue = value.clientIp;
        }
    }
    // client_ip - computed: false, optional: true, required: false
    _clientIp = new ServiceSpecSessionAffinityConfigClientIpOutputReference(this, "client_ip");
    get clientIp() {
        return this._clientIp;
    }
    putClientIp(value) {
        this._clientIp.internalValue = value;
    }
    resetClientIp() {
        this._clientIp.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get clientIpInput() {
        return this._clientIp.internalValue;
    }
}
export function serviceSpecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        allocate_load_balancer_node_ports: cdktf.booleanToTerraform(struct.allocateLoadBalancerNodePorts),
        cluster_ip: cdktf.stringToTerraform(struct.clusterIp),
        cluster_ips: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.clusterIps),
        external_ips: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.externalIps),
        external_name: cdktf.stringToTerraform(struct.externalName),
        external_traffic_policy: cdktf.stringToTerraform(struct.externalTrafficPolicy),
        health_check_node_port: cdktf.numberToTerraform(struct.healthCheckNodePort),
        internal_traffic_policy: cdktf.stringToTerraform(struct.internalTrafficPolicy),
        ip_families: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.ipFamilies),
        ip_family_policy: cdktf.stringToTerraform(struct.ipFamilyPolicy),
        load_balancer_class: cdktf.stringToTerraform(struct.loadBalancerClass),
        load_balancer_ip: cdktf.stringToTerraform(struct.loadBalancerIp),
        load_balancer_source_ranges: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.loadBalancerSourceRanges),
        publish_not_ready_addresses: cdktf.booleanToTerraform(struct.publishNotReadyAddresses),
        selector: cdktf.hashMapper(cdktf.stringToTerraform)(struct.selector),
        session_affinity: cdktf.stringToTerraform(struct.sessionAffinity),
        type: cdktf.stringToTerraform(struct.type),
        port: cdktf.listMapper(serviceSpecPortToTerraform, true)(struct.port),
        session_affinity_config: serviceSpecSessionAffinityConfigToTerraform(struct.sessionAffinityConfig),
    };
}
export function serviceSpecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        allocate_load_balancer_node_ports: {
            value: cdktf.booleanToHclTerraform(struct.allocateLoadBalancerNodePorts),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        cluster_ip: {
            value: cdktf.stringToHclTerraform(struct.clusterIp),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        cluster_ips: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.clusterIps),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        external_ips: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.externalIps),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        external_name: {
            value: cdktf.stringToHclTerraform(struct.externalName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        external_traffic_policy: {
            value: cdktf.stringToHclTerraform(struct.externalTrafficPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        health_check_node_port: {
            value: cdktf.numberToHclTerraform(struct.healthCheckNodePort),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        internal_traffic_policy: {
            value: cdktf.stringToHclTerraform(struct.internalTrafficPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        ip_families: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.ipFamilies),
            isBlock: false,
            type: "list",
            storageClassType: "stringList",
        },
        ip_family_policy: {
            value: cdktf.stringToHclTerraform(struct.ipFamilyPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        load_balancer_class: {
            value: cdktf.stringToHclTerraform(struct.loadBalancerClass),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        load_balancer_ip: {
            value: cdktf.stringToHclTerraform(struct.loadBalancerIp),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        load_balancer_source_ranges: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.loadBalancerSourceRanges),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        publish_not_ready_addresses: {
            value: cdktf.booleanToHclTerraform(struct.publishNotReadyAddresses),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        selector: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.selector),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        session_affinity: {
            value: cdktf.stringToHclTerraform(struct.sessionAffinity),
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
        port: {
            value: cdktf.listMapperHcl(serviceSpecPortToHclTerraform, true)(struct.port),
            isBlock: true,
            type: "list",
            storageClassType: "ServiceSpecPortList",
        },
        session_affinity_config: {
            value: serviceSpecSessionAffinityConfigToHclTerraform(struct.sessionAffinityConfig),
            isBlock: true,
            type: "list",
            storageClassType: "ServiceSpecSessionAffinityConfigList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class ServiceSpecOutputReference extends cdktf.ComplexObject {
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
        if (this._allocateLoadBalancerNodePorts !== undefined) {
            hasAnyValues = true;
            internalValueResult.allocateLoadBalancerNodePorts = this._allocateLoadBalancerNodePorts;
        }
        if (this._clusterIp !== undefined) {
            hasAnyValues = true;
            internalValueResult.clusterIp = this._clusterIp;
        }
        if (this._clusterIps !== undefined) {
            hasAnyValues = true;
            internalValueResult.clusterIps = this._clusterIps;
        }
        if (this._externalIps !== undefined) {
            hasAnyValues = true;
            internalValueResult.externalIps = this._externalIps;
        }
        if (this._externalName !== undefined) {
            hasAnyValues = true;
            internalValueResult.externalName = this._externalName;
        }
        if (this._externalTrafficPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.externalTrafficPolicy = this._externalTrafficPolicy;
        }
        if (this._healthCheckNodePort !== undefined) {
            hasAnyValues = true;
            internalValueResult.healthCheckNodePort = this._healthCheckNodePort;
        }
        if (this._internalTrafficPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.internalTrafficPolicy = this._internalTrafficPolicy;
        }
        if (this._ipFamilies !== undefined) {
            hasAnyValues = true;
            internalValueResult.ipFamilies = this._ipFamilies;
        }
        if (this._ipFamilyPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.ipFamilyPolicy = this._ipFamilyPolicy;
        }
        if (this._loadBalancerClass !== undefined) {
            hasAnyValues = true;
            internalValueResult.loadBalancerClass = this._loadBalancerClass;
        }
        if (this._loadBalancerIp !== undefined) {
            hasAnyValues = true;
            internalValueResult.loadBalancerIp = this._loadBalancerIp;
        }
        if (this._loadBalancerSourceRanges !== undefined) {
            hasAnyValues = true;
            internalValueResult.loadBalancerSourceRanges = this._loadBalancerSourceRanges;
        }
        if (this._publishNotReadyAddresses !== undefined) {
            hasAnyValues = true;
            internalValueResult.publishNotReadyAddresses = this._publishNotReadyAddresses;
        }
        if (this._selector !== undefined) {
            hasAnyValues = true;
            internalValueResult.selector = this._selector;
        }
        if (this._sessionAffinity !== undefined) {
            hasAnyValues = true;
            internalValueResult.sessionAffinity = this._sessionAffinity;
        }
        if (this._type !== undefined) {
            hasAnyValues = true;
            internalValueResult.type = this._type;
        }
        if (this._port?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.port = this._port?.internalValue;
        }
        if (this._sessionAffinityConfig?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.sessionAffinityConfig = this._sessionAffinityConfig?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._allocateLoadBalancerNodePorts = undefined;
            this._clusterIp = undefined;
            this._clusterIps = undefined;
            this._externalIps = undefined;
            this._externalName = undefined;
            this._externalTrafficPolicy = undefined;
            this._healthCheckNodePort = undefined;
            this._internalTrafficPolicy = undefined;
            this._ipFamilies = undefined;
            this._ipFamilyPolicy = undefined;
            this._loadBalancerClass = undefined;
            this._loadBalancerIp = undefined;
            this._loadBalancerSourceRanges = undefined;
            this._publishNotReadyAddresses = undefined;
            this._selector = undefined;
            this._sessionAffinity = undefined;
            this._type = undefined;
            this._port.internalValue = undefined;
            this._sessionAffinityConfig.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._allocateLoadBalancerNodePorts = value.allocateLoadBalancerNodePorts;
            this._clusterIp = value.clusterIp;
            this._clusterIps = value.clusterIps;
            this._externalIps = value.externalIps;
            this._externalName = value.externalName;
            this._externalTrafficPolicy = value.externalTrafficPolicy;
            this._healthCheckNodePort = value.healthCheckNodePort;
            this._internalTrafficPolicy = value.internalTrafficPolicy;
            this._ipFamilies = value.ipFamilies;
            this._ipFamilyPolicy = value.ipFamilyPolicy;
            this._loadBalancerClass = value.loadBalancerClass;
            this._loadBalancerIp = value.loadBalancerIp;
            this._loadBalancerSourceRanges = value.loadBalancerSourceRanges;
            this._publishNotReadyAddresses = value.publishNotReadyAddresses;
            this._selector = value.selector;
            this._sessionAffinity = value.sessionAffinity;
            this._type = value.type;
            this._port.internalValue = value.port;
            this._sessionAffinityConfig.internalValue = value.sessionAffinityConfig;
        }
    }
    // allocate_load_balancer_node_ports - computed: false, optional: true, required: false
    _allocateLoadBalancerNodePorts;
    get allocateLoadBalancerNodePorts() {
        return this.getBooleanAttribute('allocate_load_balancer_node_ports');
    }
    set allocateLoadBalancerNodePorts(value) {
        this._allocateLoadBalancerNodePorts = value;
    }
    resetAllocateLoadBalancerNodePorts() {
        this._allocateLoadBalancerNodePorts = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get allocateLoadBalancerNodePortsInput() {
        return this._allocateLoadBalancerNodePorts;
    }
    // cluster_ip - computed: true, optional: true, required: false
    _clusterIp;
    get clusterIp() {
        return this.getStringAttribute('cluster_ip');
    }
    set clusterIp(value) {
        this._clusterIp = value;
    }
    resetClusterIp() {
        this._clusterIp = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get clusterIpInput() {
        return this._clusterIp;
    }
    // cluster_ips - computed: true, optional: true, required: false
    _clusterIps;
    get clusterIps() {
        return this.getListAttribute('cluster_ips');
    }
    set clusterIps(value) {
        this._clusterIps = value;
    }
    resetClusterIps() {
        this._clusterIps = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get clusterIpsInput() {
        return this._clusterIps;
    }
    // external_ips - computed: false, optional: true, required: false
    _externalIps;
    get externalIps() {
        return cdktf.Fn.tolist(this.getListAttribute('external_ips'));
    }
    set externalIps(value) {
        this._externalIps = value;
    }
    resetExternalIps() {
        this._externalIps = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get externalIpsInput() {
        return this._externalIps;
    }
    // external_name - computed: false, optional: true, required: false
    _externalName;
    get externalName() {
        return this.getStringAttribute('external_name');
    }
    set externalName(value) {
        this._externalName = value;
    }
    resetExternalName() {
        this._externalName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get externalNameInput() {
        return this._externalName;
    }
    // external_traffic_policy - computed: true, optional: true, required: false
    _externalTrafficPolicy;
    get externalTrafficPolicy() {
        return this.getStringAttribute('external_traffic_policy');
    }
    set externalTrafficPolicy(value) {
        this._externalTrafficPolicy = value;
    }
    resetExternalTrafficPolicy() {
        this._externalTrafficPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get externalTrafficPolicyInput() {
        return this._externalTrafficPolicy;
    }
    // health_check_node_port - computed: true, optional: true, required: false
    _healthCheckNodePort;
    get healthCheckNodePort() {
        return this.getNumberAttribute('health_check_node_port');
    }
    set healthCheckNodePort(value) {
        this._healthCheckNodePort = value;
    }
    resetHealthCheckNodePort() {
        this._healthCheckNodePort = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get healthCheckNodePortInput() {
        return this._healthCheckNodePort;
    }
    // internal_traffic_policy - computed: true, optional: true, required: false
    _internalTrafficPolicy;
    get internalTrafficPolicy() {
        return this.getStringAttribute('internal_traffic_policy');
    }
    set internalTrafficPolicy(value) {
        this._internalTrafficPolicy = value;
    }
    resetInternalTrafficPolicy() {
        this._internalTrafficPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get internalTrafficPolicyInput() {
        return this._internalTrafficPolicy;
    }
    // ip_families - computed: true, optional: true, required: false
    _ipFamilies;
    get ipFamilies() {
        return this.getListAttribute('ip_families');
    }
    set ipFamilies(value) {
        this._ipFamilies = value;
    }
    resetIpFamilies() {
        this._ipFamilies = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get ipFamiliesInput() {
        return this._ipFamilies;
    }
    // ip_family_policy - computed: true, optional: true, required: false
    _ipFamilyPolicy;
    get ipFamilyPolicy() {
        return this.getStringAttribute('ip_family_policy');
    }
    set ipFamilyPolicy(value) {
        this._ipFamilyPolicy = value;
    }
    resetIpFamilyPolicy() {
        this._ipFamilyPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get ipFamilyPolicyInput() {
        return this._ipFamilyPolicy;
    }
    // load_balancer_class - computed: false, optional: true, required: false
    _loadBalancerClass;
    get loadBalancerClass() {
        return this.getStringAttribute('load_balancer_class');
    }
    set loadBalancerClass(value) {
        this._loadBalancerClass = value;
    }
    resetLoadBalancerClass() {
        this._loadBalancerClass = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get loadBalancerClassInput() {
        return this._loadBalancerClass;
    }
    // load_balancer_ip - computed: false, optional: true, required: false
    _loadBalancerIp;
    get loadBalancerIp() {
        return this.getStringAttribute('load_balancer_ip');
    }
    set loadBalancerIp(value) {
        this._loadBalancerIp = value;
    }
    resetLoadBalancerIp() {
        this._loadBalancerIp = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get loadBalancerIpInput() {
        return this._loadBalancerIp;
    }
    // load_balancer_source_ranges - computed: false, optional: true, required: false
    _loadBalancerSourceRanges;
    get loadBalancerSourceRanges() {
        return cdktf.Fn.tolist(this.getListAttribute('load_balancer_source_ranges'));
    }
    set loadBalancerSourceRanges(value) {
        this._loadBalancerSourceRanges = value;
    }
    resetLoadBalancerSourceRanges() {
        this._loadBalancerSourceRanges = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get loadBalancerSourceRangesInput() {
        return this._loadBalancerSourceRanges;
    }
    // publish_not_ready_addresses - computed: false, optional: true, required: false
    _publishNotReadyAddresses;
    get publishNotReadyAddresses() {
        return this.getBooleanAttribute('publish_not_ready_addresses');
    }
    set publishNotReadyAddresses(value) {
        this._publishNotReadyAddresses = value;
    }
    resetPublishNotReadyAddresses() {
        this._publishNotReadyAddresses = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get publishNotReadyAddressesInput() {
        return this._publishNotReadyAddresses;
    }
    // selector - computed: false, optional: true, required: false
    _selector;
    get selector() {
        return this.getStringMapAttribute('selector');
    }
    set selector(value) {
        this._selector = value;
    }
    resetSelector() {
        this._selector = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get selectorInput() {
        return this._selector;
    }
    // session_affinity - computed: false, optional: true, required: false
    _sessionAffinity;
    get sessionAffinity() {
        return this.getStringAttribute('session_affinity');
    }
    set sessionAffinity(value) {
        this._sessionAffinity = value;
    }
    resetSessionAffinity() {
        this._sessionAffinity = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get sessionAffinityInput() {
        return this._sessionAffinity;
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
    // port - computed: false, optional: true, required: false
    _port = new ServiceSpecPortList(this, "port", false);
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
    // session_affinity_config - computed: false, optional: true, required: false
    _sessionAffinityConfig = new ServiceSpecSessionAffinityConfigOutputReference(this, "session_affinity_config");
    get sessionAffinityConfig() {
        return this._sessionAffinityConfig;
    }
    putSessionAffinityConfig(value) {
        this._sessionAffinityConfig.internalValue = value;
    }
    resetSessionAffinityConfig() {
        this._sessionAffinityConfig.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get sessionAffinityConfigInput() {
        return this._sessionAffinityConfig.internalValue;
    }
}
export function serviceTimeoutsToTerraform(struct) {
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
export function serviceTimeoutsToHclTerraform(struct) {
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
export class ServiceTimeoutsOutputReference extends cdktf.ComplexObject {
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
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service kubernetes_service}
*/
export class Service extends cdktf.TerraformResource {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "kubernetes_service";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a Service resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Service to import
    * @param importFromId The id of the existing Service that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Service to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "kubernetes_service", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/service kubernetes_service} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options ServiceConfig
    */
    constructor(scope, id, config) {
        super(scope, id, {
            terraformResourceType: 'kubernetes_service',
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
        this._waitForLoadBalancer = config.waitForLoadBalancer;
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
    // status - computed: true, optional: false, required: false
    _status = new ServiceStatusList(this, "status", false);
    get status() {
        return this._status;
    }
    // wait_for_load_balancer - computed: false, optional: true, required: false
    _waitForLoadBalancer;
    get waitForLoadBalancer() {
        return this.getBooleanAttribute('wait_for_load_balancer');
    }
    set waitForLoadBalancer(value) {
        this._waitForLoadBalancer = value;
    }
    resetWaitForLoadBalancer() {
        this._waitForLoadBalancer = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get waitForLoadBalancerInput() {
        return this._waitForLoadBalancer;
    }
    // metadata - computed: false, optional: false, required: true
    _metadata = new ServiceMetadataOutputReference(this, "metadata");
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
    _spec = new ServiceSpecOutputReference(this, "spec");
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
    _timeouts = new ServiceTimeoutsOutputReference(this, "timeouts");
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
            wait_for_load_balancer: cdktf.booleanToTerraform(this._waitForLoadBalancer),
            metadata: serviceMetadataToTerraform(this._metadata.internalValue),
            spec: serviceSpecToTerraform(this._spec.internalValue),
            timeouts: serviceTimeoutsToTerraform(this._timeouts.internalValue),
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
            wait_for_load_balancer: {
                value: cdktf.booleanToHclTerraform(this._waitForLoadBalancer),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            metadata: {
                value: serviceMetadataToHclTerraform(this._metadata.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "ServiceMetadataList",
            },
            spec: {
                value: serviceSpecToHclTerraform(this._spec.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "ServiceSpecList",
            },
            timeouts: {
                value: serviceTimeoutsToHclTerraform(this._timeouts.internalValue),
                isBlock: true,
                type: "struct",
                storageClassType: "ServiceTimeouts",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
