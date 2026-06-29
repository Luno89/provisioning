import * as cdktf from 'cdktf';
import { deploymentSpecTemplateSpecInitContainerLivenessProbeExecToTerraform, deploymentSpecTemplateSpecInitContainerLivenessProbeExecToHclTerraform, DeploymentSpecTemplateSpecInitContainerLivenessProbeExecOutputReference, deploymentSpecTemplateSpecInitContainerLivenessProbeGrpcToTerraform, deploymentSpecTemplateSpecInitContainerLivenessProbeGrpcToHclTerraform, DeploymentSpecTemplateSpecInitContainerLivenessProbeGrpcList, deploymentSpecTemplateSpecInitContainerEnvToTerraform, deploymentSpecTemplateSpecInitContainerEnvToHclTerraform, DeploymentSpecTemplateSpecInitContainerEnvList, deploymentSpecTemplateSpecInitContainerEnvFromToTerraform, deploymentSpecTemplateSpecInitContainerEnvFromToHclTerraform, DeploymentSpecTemplateSpecInitContainerEnvFromList, deploymentSpecTemplateSpecInitContainerLifecycleToTerraform, deploymentSpecTemplateSpecInitContainerLifecycleToHclTerraform, DeploymentSpecTemplateSpecInitContainerLifecycleOutputReference, deploymentSpecTemplateSpecAffinityToTerraform, deploymentSpecTemplateSpecAffinityToHclTerraform, DeploymentSpecTemplateSpecAffinityOutputReference, deploymentSpecTemplateSpecContainerToTerraform, deploymentSpecTemplateSpecContainerToHclTerraform, DeploymentSpecTemplateSpecContainerList, deploymentSpecTemplateSpecDnsConfigToTerraform, deploymentSpecTemplateSpecDnsConfigToHclTerraform, DeploymentSpecTemplateSpecDnsConfigOutputReference, deploymentSpecTemplateSpecHostAliasesToTerraform, deploymentSpecTemplateSpecHostAliasesToHclTerraform, DeploymentSpecTemplateSpecHostAliasesList, deploymentSpecTemplateSpecImagePullSecretsToTerraform, deploymentSpecTemplateSpecImagePullSecretsToHclTerraform, DeploymentSpecTemplateSpecImagePullSecretsList, deploymentSpecTemplateMetadataToTerraform, deploymentSpecTemplateMetadataToHclTerraform, DeploymentSpecTemplateMetadataOutputReference, deploymentSpecSelectorToTerraform, deploymentSpecSelectorToHclTerraform, DeploymentSpecSelectorOutputReference, deploymentSpecStrategyToTerraform, deploymentSpecStrategyToHclTerraform, DeploymentSpecStrategyOutputReference } from './structs0';
export function deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetToTerraform(struct) {
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
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetOutputReference extends cdktf.ComplexObject {
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
    _httpHeader = new DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetHttpHeaderList(this, "http_header", false);
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
export function deploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeToTerraform(struct) {
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
        exec: deploymentSpecTemplateSpecInitContainerLivenessProbeExecToTerraform(struct.exec),
        grpc: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLivenessProbeGrpcToTerraform, true)(struct.grpc),
        http_get: deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecInitContainerLivenessProbeToHclTerraform(struct) {
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
            value: deploymentSpecTemplateSpecInitContainerLivenessProbeExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLivenessProbeExecList",
        },
        grpc: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLivenessProbeGrpcToHclTerraform, true)(struct.grpc),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLivenessProbeGrpcList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerLivenessProbeOutputReference extends cdktf.ComplexObject {
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
    _exec = new DeploymentSpecTemplateSpecInitContainerLivenessProbeExecOutputReference(this, "exec");
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
    _grpc = new DeploymentSpecTemplateSpecInitContainerLivenessProbeGrpcList(this, "grpc", false);
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
    _httpGet = new DeploymentSpecTemplateSpecInitContainerLivenessProbeHttpGetOutputReference(this, "http_get");
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
    _tcpSocket = new DeploymentSpecTemplateSpecInitContainerLivenessProbeTcpSocketList(this, "tcp_socket", false);
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
export function deploymentSpecTemplateSpecInitContainerPortToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerPortToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerPortOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerPortList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerPortOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerReadinessProbeExecToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerReadinessProbeExecToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeExecOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecInitContainerReadinessProbeGrpcToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerReadinessProbeGrpcToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeGrpcOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeGrpcList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerReadinessProbeGrpcOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetToTerraform(struct) {
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
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetOutputReference extends cdktf.ComplexObject {
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
    _httpHeader = new DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetHttpHeaderList(this, "http_header", false);
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
export function deploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerReadinessProbeToTerraform(struct) {
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
        exec: deploymentSpecTemplateSpecInitContainerReadinessProbeExecToTerraform(struct.exec),
        grpc: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerReadinessProbeGrpcToTerraform, true)(struct.grpc),
        http_get: deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecInitContainerReadinessProbeToHclTerraform(struct) {
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
            value: deploymentSpecTemplateSpecInitContainerReadinessProbeExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerReadinessProbeExecList",
        },
        grpc: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerReadinessProbeGrpcToHclTerraform, true)(struct.grpc),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerReadinessProbeGrpcList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerReadinessProbeOutputReference extends cdktf.ComplexObject {
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
    _exec = new DeploymentSpecTemplateSpecInitContainerReadinessProbeExecOutputReference(this, "exec");
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
    _grpc = new DeploymentSpecTemplateSpecInitContainerReadinessProbeGrpcList(this, "grpc", false);
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
    _httpGet = new DeploymentSpecTemplateSpecInitContainerReadinessProbeHttpGetOutputReference(this, "http_get");
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
    _tcpSocket = new DeploymentSpecTemplateSpecInitContainerReadinessProbeTcpSocketList(this, "tcp_socket", false);
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
export function deploymentSpecTemplateSpecInitContainerResourcesToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerResourcesToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerResourcesOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecInitContainerSecurityContextCapabilitiesToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerSecurityContextCapabilitiesToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerSecurityContextCapabilitiesOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecInitContainerSecurityContextSeLinuxOptionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerSecurityContextSeLinuxOptionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerSecurityContextSeLinuxOptionsOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecInitContainerSecurityContextSeccompProfileToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerSecurityContextSeccompProfileToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerSecurityContextSeccompProfileOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecInitContainerSecurityContextToTerraform(struct) {
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
        capabilities: deploymentSpecTemplateSpecInitContainerSecurityContextCapabilitiesToTerraform(struct.capabilities),
        se_linux_options: deploymentSpecTemplateSpecInitContainerSecurityContextSeLinuxOptionsToTerraform(struct.seLinuxOptions),
        seccomp_profile: deploymentSpecTemplateSpecInitContainerSecurityContextSeccompProfileToTerraform(struct.seccompProfile),
    };
}
export function deploymentSpecTemplateSpecInitContainerSecurityContextToHclTerraform(struct) {
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
            value: deploymentSpecTemplateSpecInitContainerSecurityContextCapabilitiesToHclTerraform(struct.capabilities),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerSecurityContextCapabilitiesList",
        },
        se_linux_options: {
            value: deploymentSpecTemplateSpecInitContainerSecurityContextSeLinuxOptionsToHclTerraform(struct.seLinuxOptions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerSecurityContextSeLinuxOptionsList",
        },
        seccomp_profile: {
            value: deploymentSpecTemplateSpecInitContainerSecurityContextSeccompProfileToHclTerraform(struct.seccompProfile),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerSecurityContextSeccompProfileList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerSecurityContextOutputReference extends cdktf.ComplexObject {
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
    _capabilities = new DeploymentSpecTemplateSpecInitContainerSecurityContextCapabilitiesOutputReference(this, "capabilities");
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
    _seLinuxOptions = new DeploymentSpecTemplateSpecInitContainerSecurityContextSeLinuxOptionsOutputReference(this, "se_linux_options");
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
    _seccompProfile = new DeploymentSpecTemplateSpecInitContainerSecurityContextSeccompProfileOutputReference(this, "seccomp_profile");
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
export function deploymentSpecTemplateSpecInitContainerStartupProbeExecToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerStartupProbeExecToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerStartupProbeExecOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecInitContainerStartupProbeGrpcToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerStartupProbeGrpcToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerStartupProbeGrpcOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerStartupProbeGrpcList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerStartupProbeGrpcOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetToTerraform(struct) {
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
        http_header: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderToTerraform, true)(struct.httpHeader),
    };
}
export function deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderToHclTerraform, true)(struct.httpHeader),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetOutputReference extends cdktf.ComplexObject {
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
    _httpHeader = new DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetHttpHeaderList(this, "http_header", false);
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
export function deploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerStartupProbeToTerraform(struct) {
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
        exec: deploymentSpecTemplateSpecInitContainerStartupProbeExecToTerraform(struct.exec),
        grpc: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerStartupProbeGrpcToTerraform, true)(struct.grpc),
        http_get: deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetToTerraform(struct.httpGet),
        tcp_socket: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketToTerraform, true)(struct.tcpSocket),
    };
}
export function deploymentSpecTemplateSpecInitContainerStartupProbeToHclTerraform(struct) {
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
            value: deploymentSpecTemplateSpecInitContainerStartupProbeExecToHclTerraform(struct.exec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerStartupProbeExecList",
        },
        grpc: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerStartupProbeGrpcToHclTerraform, true)(struct.grpc),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerStartupProbeGrpcList",
        },
        http_get: {
            value: deploymentSpecTemplateSpecInitContainerStartupProbeHttpGetToHclTerraform(struct.httpGet),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetList",
        },
        tcp_socket: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketToHclTerraform, true)(struct.tcpSocket),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerStartupProbeOutputReference extends cdktf.ComplexObject {
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
    _exec = new DeploymentSpecTemplateSpecInitContainerStartupProbeExecOutputReference(this, "exec");
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
    _grpc = new DeploymentSpecTemplateSpecInitContainerStartupProbeGrpcList(this, "grpc", false);
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
    _httpGet = new DeploymentSpecTemplateSpecInitContainerStartupProbeHttpGetOutputReference(this, "http_get");
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
    _tcpSocket = new DeploymentSpecTemplateSpecInitContainerStartupProbeTcpSocketList(this, "tcp_socket", false);
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
export function deploymentSpecTemplateSpecInitContainerVolumeDeviceToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerVolumeDeviceToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerVolumeDeviceOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerVolumeDeviceList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerVolumeDeviceOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerVolumeMountToTerraform(struct) {
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
export function deploymentSpecTemplateSpecInitContainerVolumeMountToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecInitContainerVolumeMountOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecInitContainerVolumeMountList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerVolumeMountOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecInitContainerToTerraform(struct) {
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
        env: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerEnvToTerraform, true)(struct.env),
        env_from: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerEnvFromToTerraform, true)(struct.envFrom),
        lifecycle: deploymentSpecTemplateSpecInitContainerLifecycleToTerraform(struct.lifecycle),
        liveness_probe: deploymentSpecTemplateSpecInitContainerLivenessProbeToTerraform(struct.livenessProbe),
        port: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerPortToTerraform, true)(struct.port),
        readiness_probe: deploymentSpecTemplateSpecInitContainerReadinessProbeToTerraform(struct.readinessProbe),
        resources: deploymentSpecTemplateSpecInitContainerResourcesToTerraform(struct.resources),
        security_context: deploymentSpecTemplateSpecInitContainerSecurityContextToTerraform(struct.securityContext),
        startup_probe: deploymentSpecTemplateSpecInitContainerStartupProbeToTerraform(struct.startupProbe),
        volume_device: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerVolumeDeviceToTerraform, true)(struct.volumeDevice),
        volume_mount: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerVolumeMountToTerraform, true)(struct.volumeMount),
    };
}
export function deploymentSpecTemplateSpecInitContainerToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerEnvToHclTerraform, true)(struct.env),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvList",
        },
        env_from: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerEnvFromToHclTerraform, true)(struct.envFrom),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerEnvFromList",
        },
        lifecycle: {
            value: deploymentSpecTemplateSpecInitContainerLifecycleToHclTerraform(struct.lifecycle),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLifecycleList",
        },
        liveness_probe: {
            value: deploymentSpecTemplateSpecInitContainerLivenessProbeToHclTerraform(struct.livenessProbe),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerLivenessProbeList",
        },
        port: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerPortToHclTerraform, true)(struct.port),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerPortList",
        },
        readiness_probe: {
            value: deploymentSpecTemplateSpecInitContainerReadinessProbeToHclTerraform(struct.readinessProbe),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerReadinessProbeList",
        },
        resources: {
            value: deploymentSpecTemplateSpecInitContainerResourcesToHclTerraform(struct.resources),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerResourcesList",
        },
        security_context: {
            value: deploymentSpecTemplateSpecInitContainerSecurityContextToHclTerraform(struct.securityContext),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerSecurityContextList",
        },
        startup_probe: {
            value: deploymentSpecTemplateSpecInitContainerStartupProbeToHclTerraform(struct.startupProbe),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerStartupProbeList",
        },
        volume_device: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerVolumeDeviceToHclTerraform, true)(struct.volumeDevice),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerVolumeDeviceList",
        },
        volume_mount: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerVolumeMountToHclTerraform, true)(struct.volumeMount),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerVolumeMountList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecInitContainerOutputReference extends cdktf.ComplexObject {
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
    _env = new DeploymentSpecTemplateSpecInitContainerEnvList(this, "env", false);
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
    _envFrom = new DeploymentSpecTemplateSpecInitContainerEnvFromList(this, "env_from", false);
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
    _lifecycle = new DeploymentSpecTemplateSpecInitContainerLifecycleOutputReference(this, "lifecycle");
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
    _livenessProbe = new DeploymentSpecTemplateSpecInitContainerLivenessProbeOutputReference(this, "liveness_probe");
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
    _port = new DeploymentSpecTemplateSpecInitContainerPortList(this, "port", false);
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
    _readinessProbe = new DeploymentSpecTemplateSpecInitContainerReadinessProbeOutputReference(this, "readiness_probe");
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
    _resources = new DeploymentSpecTemplateSpecInitContainerResourcesOutputReference(this, "resources");
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
    _securityContext = new DeploymentSpecTemplateSpecInitContainerSecurityContextOutputReference(this, "security_context");
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
    _startupProbe = new DeploymentSpecTemplateSpecInitContainerStartupProbeOutputReference(this, "startup_probe");
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
    _volumeDevice = new DeploymentSpecTemplateSpecInitContainerVolumeDeviceList(this, "volume_device", false);
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
    _volumeMount = new DeploymentSpecTemplateSpecInitContainerVolumeMountList(this, "volume_mount", false);
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
export class DeploymentSpecTemplateSpecInitContainerList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecInitContainerOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecOsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecOsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecOsOutputReference extends cdktf.ComplexObject {
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
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
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
export function deploymentSpecTemplateSpecReadinessGateToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        condition_type: cdktf.stringToTerraform(struct.conditionType),
    };
}
export function deploymentSpecTemplateSpecReadinessGateToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        condition_type: {
            value: cdktf.stringToHclTerraform(struct.conditionType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecReadinessGateOutputReference extends cdktf.ComplexObject {
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
        if (this._conditionType !== undefined) {
            hasAnyValues = true;
            internalValueResult.conditionType = this._conditionType;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._conditionType = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._conditionType = value.conditionType;
        }
    }
    // condition_type - computed: false, optional: false, required: true
    _conditionType;
    get conditionType() {
        return this.getStringAttribute('condition_type');
    }
    set conditionType(value) {
        this._conditionType = value;
    }
    // Temporarily expose input value. Use with caution.
    get conditionTypeInput() {
        return this._conditionType;
    }
}
export class DeploymentSpecTemplateSpecReadinessGateList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecReadinessGateOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecSecurityContextSeLinuxOptionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecSecurityContextSeLinuxOptionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecSecurityContextSeLinuxOptionsOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecSecurityContextSeccompProfileToTerraform(struct) {
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
export function deploymentSpecTemplateSpecSecurityContextSeccompProfileToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecSecurityContextSeccompProfileOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecSecurityContextSysctlToTerraform(struct) {
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
export function deploymentSpecTemplateSpecSecurityContextSysctlToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecSecurityContextSysctlOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecSecurityContextSysctlList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecSecurityContextSysctlOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecSecurityContextWindowsOptionsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        gmsa_credential_spec: cdktf.stringToTerraform(struct.gmsaCredentialSpec),
        gmsa_credential_spec_name: cdktf.stringToTerraform(struct.gmsaCredentialSpecName),
        host_process: cdktf.booleanToTerraform(struct.hostProcess),
        run_as_username: cdktf.stringToTerraform(struct.runAsUsername),
    };
}
export function deploymentSpecTemplateSpecSecurityContextWindowsOptionsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        gmsa_credential_spec: {
            value: cdktf.stringToHclTerraform(struct.gmsaCredentialSpec),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        gmsa_credential_spec_name: {
            value: cdktf.stringToHclTerraform(struct.gmsaCredentialSpecName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        host_process: {
            value: cdktf.booleanToHclTerraform(struct.hostProcess),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        run_as_username: {
            value: cdktf.stringToHclTerraform(struct.runAsUsername),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecSecurityContextWindowsOptionsOutputReference extends cdktf.ComplexObject {
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
        if (this._gmsaCredentialSpec !== undefined) {
            hasAnyValues = true;
            internalValueResult.gmsaCredentialSpec = this._gmsaCredentialSpec;
        }
        if (this._gmsaCredentialSpecName !== undefined) {
            hasAnyValues = true;
            internalValueResult.gmsaCredentialSpecName = this._gmsaCredentialSpecName;
        }
        if (this._hostProcess !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostProcess = this._hostProcess;
        }
        if (this._runAsUsername !== undefined) {
            hasAnyValues = true;
            internalValueResult.runAsUsername = this._runAsUsername;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._gmsaCredentialSpec = undefined;
            this._gmsaCredentialSpecName = undefined;
            this._hostProcess = undefined;
            this._runAsUsername = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._gmsaCredentialSpec = value.gmsaCredentialSpec;
            this._gmsaCredentialSpecName = value.gmsaCredentialSpecName;
            this._hostProcess = value.hostProcess;
            this._runAsUsername = value.runAsUsername;
        }
    }
    // gmsa_credential_spec - computed: false, optional: true, required: false
    _gmsaCredentialSpec;
    get gmsaCredentialSpec() {
        return this.getStringAttribute('gmsa_credential_spec');
    }
    set gmsaCredentialSpec(value) {
        this._gmsaCredentialSpec = value;
    }
    resetGmsaCredentialSpec() {
        this._gmsaCredentialSpec = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get gmsaCredentialSpecInput() {
        return this._gmsaCredentialSpec;
    }
    // gmsa_credential_spec_name - computed: false, optional: true, required: false
    _gmsaCredentialSpecName;
    get gmsaCredentialSpecName() {
        return this.getStringAttribute('gmsa_credential_spec_name');
    }
    set gmsaCredentialSpecName(value) {
        this._gmsaCredentialSpecName = value;
    }
    resetGmsaCredentialSpecName() {
        this._gmsaCredentialSpecName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get gmsaCredentialSpecNameInput() {
        return this._gmsaCredentialSpecName;
    }
    // host_process - computed: false, optional: true, required: false
    _hostProcess;
    get hostProcess() {
        return this.getBooleanAttribute('host_process');
    }
    set hostProcess(value) {
        this._hostProcess = value;
    }
    resetHostProcess() {
        this._hostProcess = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostProcessInput() {
        return this._hostProcess;
    }
    // run_as_username - computed: false, optional: true, required: false
    _runAsUsername;
    get runAsUsername() {
        return this.getStringAttribute('run_as_username');
    }
    set runAsUsername(value) {
        this._runAsUsername = value;
    }
    resetRunAsUsername() {
        this._runAsUsername = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get runAsUsernameInput() {
        return this._runAsUsername;
    }
}
export function deploymentSpecTemplateSpecSecurityContextToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_group: cdktf.stringToTerraform(struct.fsGroup),
        fs_group_change_policy: cdktf.stringToTerraform(struct.fsGroupChangePolicy),
        run_as_group: cdktf.stringToTerraform(struct.runAsGroup),
        run_as_non_root: cdktf.booleanToTerraform(struct.runAsNonRoot),
        run_as_user: cdktf.stringToTerraform(struct.runAsUser),
        supplemental_groups: cdktf.listMapper(cdktf.numberToTerraform, false)(struct.supplementalGroups),
        se_linux_options: deploymentSpecTemplateSpecSecurityContextSeLinuxOptionsToTerraform(struct.seLinuxOptions),
        seccomp_profile: deploymentSpecTemplateSpecSecurityContextSeccompProfileToTerraform(struct.seccompProfile),
        sysctl: cdktf.listMapper(deploymentSpecTemplateSpecSecurityContextSysctlToTerraform, true)(struct.sysctl),
        windows_options: deploymentSpecTemplateSpecSecurityContextWindowsOptionsToTerraform(struct.windowsOptions),
    };
}
export function deploymentSpecTemplateSpecSecurityContextToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_group: {
            value: cdktf.stringToHclTerraform(struct.fsGroup),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        fs_group_change_policy: {
            value: cdktf.stringToHclTerraform(struct.fsGroupChangePolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
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
        supplemental_groups: {
            value: cdktf.listMapperHcl(cdktf.numberToHclTerraform, false)(struct.supplementalGroups),
            isBlock: false,
            type: "set",
            storageClassType: "numberList",
        },
        se_linux_options: {
            value: deploymentSpecTemplateSpecSecurityContextSeLinuxOptionsToHclTerraform(struct.seLinuxOptions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecSecurityContextSeLinuxOptionsList",
        },
        seccomp_profile: {
            value: deploymentSpecTemplateSpecSecurityContextSeccompProfileToHclTerraform(struct.seccompProfile),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecSecurityContextSeccompProfileList",
        },
        sysctl: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecSecurityContextSysctlToHclTerraform, true)(struct.sysctl),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecSecurityContextSysctlList",
        },
        windows_options: {
            value: deploymentSpecTemplateSpecSecurityContextWindowsOptionsToHclTerraform(struct.windowsOptions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecSecurityContextWindowsOptionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecSecurityContextOutputReference extends cdktf.ComplexObject {
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
        if (this._fsGroup !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsGroup = this._fsGroup;
        }
        if (this._fsGroupChangePolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsGroupChangePolicy = this._fsGroupChangePolicy;
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
        if (this._supplementalGroups !== undefined) {
            hasAnyValues = true;
            internalValueResult.supplementalGroups = this._supplementalGroups;
        }
        if (this._seLinuxOptions?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.seLinuxOptions = this._seLinuxOptions?.internalValue;
        }
        if (this._seccompProfile?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.seccompProfile = this._seccompProfile?.internalValue;
        }
        if (this._sysctl?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.sysctl = this._sysctl?.internalValue;
        }
        if (this._windowsOptions?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.windowsOptions = this._windowsOptions?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsGroup = undefined;
            this._fsGroupChangePolicy = undefined;
            this._runAsGroup = undefined;
            this._runAsNonRoot = undefined;
            this._runAsUser = undefined;
            this._supplementalGroups = undefined;
            this._seLinuxOptions.internalValue = undefined;
            this._seccompProfile.internalValue = undefined;
            this._sysctl.internalValue = undefined;
            this._windowsOptions.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsGroup = value.fsGroup;
            this._fsGroupChangePolicy = value.fsGroupChangePolicy;
            this._runAsGroup = value.runAsGroup;
            this._runAsNonRoot = value.runAsNonRoot;
            this._runAsUser = value.runAsUser;
            this._supplementalGroups = value.supplementalGroups;
            this._seLinuxOptions.internalValue = value.seLinuxOptions;
            this._seccompProfile.internalValue = value.seccompProfile;
            this._sysctl.internalValue = value.sysctl;
            this._windowsOptions.internalValue = value.windowsOptions;
        }
    }
    // fs_group - computed: false, optional: true, required: false
    _fsGroup;
    get fsGroup() {
        return this.getStringAttribute('fs_group');
    }
    set fsGroup(value) {
        this._fsGroup = value;
    }
    resetFsGroup() {
        this._fsGroup = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsGroupInput() {
        return this._fsGroup;
    }
    // fs_group_change_policy - computed: false, optional: true, required: false
    _fsGroupChangePolicy;
    get fsGroupChangePolicy() {
        return this.getStringAttribute('fs_group_change_policy');
    }
    set fsGroupChangePolicy(value) {
        this._fsGroupChangePolicy = value;
    }
    resetFsGroupChangePolicy() {
        this._fsGroupChangePolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsGroupChangePolicyInput() {
        return this._fsGroupChangePolicy;
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
    // supplemental_groups - computed: false, optional: true, required: false
    _supplementalGroups;
    get supplementalGroups() {
        return cdktf.Token.asNumberList(cdktf.Fn.tolist(this.getNumberListAttribute('supplemental_groups')));
    }
    set supplementalGroups(value) {
        this._supplementalGroups = value;
    }
    resetSupplementalGroups() {
        this._supplementalGroups = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get supplementalGroupsInput() {
        return this._supplementalGroups;
    }
    // se_linux_options - computed: false, optional: true, required: false
    _seLinuxOptions = new DeploymentSpecTemplateSpecSecurityContextSeLinuxOptionsOutputReference(this, "se_linux_options");
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
    _seccompProfile = new DeploymentSpecTemplateSpecSecurityContextSeccompProfileOutputReference(this, "seccomp_profile");
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
    // sysctl - computed: false, optional: true, required: false
    _sysctl = new DeploymentSpecTemplateSpecSecurityContextSysctlList(this, "sysctl", false);
    get sysctl() {
        return this._sysctl;
    }
    putSysctl(value) {
        this._sysctl.internalValue = value;
    }
    resetSysctl() {
        this._sysctl.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get sysctlInput() {
        return this._sysctl.internalValue;
    }
    // windows_options - computed: false, optional: true, required: false
    _windowsOptions = new DeploymentSpecTemplateSpecSecurityContextWindowsOptionsOutputReference(this, "windows_options");
    get windowsOptions() {
        return this._windowsOptions;
    }
    putWindowsOptions(value) {
        this._windowsOptions.internalValue = value;
    }
    resetWindowsOptions() {
        this._windowsOptions.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get windowsOptionsInput() {
        return this._windowsOptions.internalValue;
    }
}
export function deploymentSpecTemplateSpecTolerationToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        effect: cdktf.stringToTerraform(struct.effect),
        key: cdktf.stringToTerraform(struct.key),
        operator: cdktf.stringToTerraform(struct.operator),
        toleration_seconds: cdktf.stringToTerraform(struct.tolerationSeconds),
        value: cdktf.stringToTerraform(struct.value),
    };
}
export function deploymentSpecTemplateSpecTolerationToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        effect: {
            value: cdktf.stringToHclTerraform(struct.effect),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
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
        toleration_seconds: {
            value: cdktf.stringToHclTerraform(struct.tolerationSeconds),
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
export class DeploymentSpecTemplateSpecTolerationOutputReference extends cdktf.ComplexObject {
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
        if (this._effect !== undefined) {
            hasAnyValues = true;
            internalValueResult.effect = this._effect;
        }
        if (this._key !== undefined) {
            hasAnyValues = true;
            internalValueResult.key = this._key;
        }
        if (this._operator !== undefined) {
            hasAnyValues = true;
            internalValueResult.operator = this._operator;
        }
        if (this._tolerationSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.tolerationSeconds = this._tolerationSeconds;
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
            this._effect = undefined;
            this._key = undefined;
            this._operator = undefined;
            this._tolerationSeconds = undefined;
            this._value = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._effect = value.effect;
            this._key = value.key;
            this._operator = value.operator;
            this._tolerationSeconds = value.tolerationSeconds;
            this._value = value.value;
        }
    }
    // effect - computed: false, optional: true, required: false
    _effect;
    get effect() {
        return this.getStringAttribute('effect');
    }
    set effect(value) {
        this._effect = value;
    }
    resetEffect() {
        this._effect = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get effectInput() {
        return this._effect;
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
    // toleration_seconds - computed: false, optional: true, required: false
    _tolerationSeconds;
    get tolerationSeconds() {
        return this.getStringAttribute('toleration_seconds');
    }
    set tolerationSeconds(value) {
        this._tolerationSeconds = value;
    }
    resetTolerationSeconds() {
        this._tolerationSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tolerationSecondsInput() {
        return this._tolerationSeconds;
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
export class DeploymentSpecTemplateSpecTolerationList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecTolerationOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorOutputReference extends cdktf.ComplexObject {
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
    _matchExpressions = new DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorMatchExpressionsList(this, "match_expressions", false);
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
export class DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecTopologySpreadConstraintToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_label_keys: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.matchLabelKeys),
        max_skew: cdktf.numberToTerraform(struct.maxSkew),
        min_domains: cdktf.numberToTerraform(struct.minDomains),
        node_affinity_policy: cdktf.stringToTerraform(struct.nodeAffinityPolicy),
        node_taints_policy: cdktf.stringToTerraform(struct.nodeTaintsPolicy),
        topology_key: cdktf.stringToTerraform(struct.topologyKey),
        when_unsatisfiable: cdktf.stringToTerraform(struct.whenUnsatisfiable),
        label_selector: cdktf.listMapper(deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorToTerraform, true)(struct.labelSelector),
    };
}
export function deploymentSpecTemplateSpecTopologySpreadConstraintToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        match_label_keys: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.matchLabelKeys),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        max_skew: {
            value: cdktf.numberToHclTerraform(struct.maxSkew),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        min_domains: {
            value: cdktf.numberToHclTerraform(struct.minDomains),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        node_affinity_policy: {
            value: cdktf.stringToHclTerraform(struct.nodeAffinityPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        node_taints_policy: {
            value: cdktf.stringToHclTerraform(struct.nodeTaintsPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        topology_key: {
            value: cdktf.stringToHclTerraform(struct.topologyKey),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        when_unsatisfiable: {
            value: cdktf.stringToHclTerraform(struct.whenUnsatisfiable),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        label_selector: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorToHclTerraform, true)(struct.labelSelector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecTopologySpreadConstraintOutputReference extends cdktf.ComplexObject {
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
        if (this._matchLabelKeys !== undefined) {
            hasAnyValues = true;
            internalValueResult.matchLabelKeys = this._matchLabelKeys;
        }
        if (this._maxSkew !== undefined) {
            hasAnyValues = true;
            internalValueResult.maxSkew = this._maxSkew;
        }
        if (this._minDomains !== undefined) {
            hasAnyValues = true;
            internalValueResult.minDomains = this._minDomains;
        }
        if (this._nodeAffinityPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodeAffinityPolicy = this._nodeAffinityPolicy;
        }
        if (this._nodeTaintsPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodeTaintsPolicy = this._nodeTaintsPolicy;
        }
        if (this._topologyKey !== undefined) {
            hasAnyValues = true;
            internalValueResult.topologyKey = this._topologyKey;
        }
        if (this._whenUnsatisfiable !== undefined) {
            hasAnyValues = true;
            internalValueResult.whenUnsatisfiable = this._whenUnsatisfiable;
        }
        if (this._labelSelector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.labelSelector = this._labelSelector?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._matchLabelKeys = undefined;
            this._maxSkew = undefined;
            this._minDomains = undefined;
            this._nodeAffinityPolicy = undefined;
            this._nodeTaintsPolicy = undefined;
            this._topologyKey = undefined;
            this._whenUnsatisfiable = undefined;
            this._labelSelector.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._matchLabelKeys = value.matchLabelKeys;
            this._maxSkew = value.maxSkew;
            this._minDomains = value.minDomains;
            this._nodeAffinityPolicy = value.nodeAffinityPolicy;
            this._nodeTaintsPolicy = value.nodeTaintsPolicy;
            this._topologyKey = value.topologyKey;
            this._whenUnsatisfiable = value.whenUnsatisfiable;
            this._labelSelector.internalValue = value.labelSelector;
        }
    }
    // match_label_keys - computed: false, optional: true, required: false
    _matchLabelKeys;
    get matchLabelKeys() {
        return cdktf.Fn.tolist(this.getListAttribute('match_label_keys'));
    }
    set matchLabelKeys(value) {
        this._matchLabelKeys = value;
    }
    resetMatchLabelKeys() {
        this._matchLabelKeys = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get matchLabelKeysInput() {
        return this._matchLabelKeys;
    }
    // max_skew - computed: false, optional: true, required: false
    _maxSkew;
    get maxSkew() {
        return this.getNumberAttribute('max_skew');
    }
    set maxSkew(value) {
        this._maxSkew = value;
    }
    resetMaxSkew() {
        this._maxSkew = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get maxSkewInput() {
        return this._maxSkew;
    }
    // min_domains - computed: false, optional: true, required: false
    _minDomains;
    get minDomains() {
        return this.getNumberAttribute('min_domains');
    }
    set minDomains(value) {
        this._minDomains = value;
    }
    resetMinDomains() {
        this._minDomains = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get minDomainsInput() {
        return this._minDomains;
    }
    // node_affinity_policy - computed: false, optional: true, required: false
    _nodeAffinityPolicy;
    get nodeAffinityPolicy() {
        return this.getStringAttribute('node_affinity_policy');
    }
    set nodeAffinityPolicy(value) {
        this._nodeAffinityPolicy = value;
    }
    resetNodeAffinityPolicy() {
        this._nodeAffinityPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodeAffinityPolicyInput() {
        return this._nodeAffinityPolicy;
    }
    // node_taints_policy - computed: false, optional: true, required: false
    _nodeTaintsPolicy;
    get nodeTaintsPolicy() {
        return this.getStringAttribute('node_taints_policy');
    }
    set nodeTaintsPolicy(value) {
        this._nodeTaintsPolicy = value;
    }
    resetNodeTaintsPolicy() {
        this._nodeTaintsPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodeTaintsPolicyInput() {
        return this._nodeTaintsPolicy;
    }
    // topology_key - computed: false, optional: true, required: false
    _topologyKey;
    get topologyKey() {
        return this.getStringAttribute('topology_key');
    }
    set topologyKey(value) {
        this._topologyKey = value;
    }
    resetTopologyKey() {
        this._topologyKey = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get topologyKeyInput() {
        return this._topologyKey;
    }
    // when_unsatisfiable - computed: false, optional: true, required: false
    _whenUnsatisfiable;
    get whenUnsatisfiable() {
        return this.getStringAttribute('when_unsatisfiable');
    }
    set whenUnsatisfiable(value) {
        this._whenUnsatisfiable = value;
    }
    resetWhenUnsatisfiable() {
        this._whenUnsatisfiable = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get whenUnsatisfiableInput() {
        return this._whenUnsatisfiable;
    }
    // label_selector - computed: false, optional: true, required: false
    _labelSelector = new DeploymentSpecTemplateSpecTopologySpreadConstraintLabelSelectorList(this, "label_selector", false);
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
}
export class DeploymentSpecTemplateSpecTopologySpreadConstraintList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecTopologySpreadConstraintOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeAwsElasticBlockStoreToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_type: cdktf.stringToTerraform(struct.fsType),
        partition: cdktf.numberToTerraform(struct.partition),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        volume_id: cdktf.stringToTerraform(struct.volumeId),
    };
}
export function deploymentSpecTemplateSpecVolumeAwsElasticBlockStoreToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        partition: {
            value: cdktf.numberToHclTerraform(struct.partition),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        read_only: {
            value: cdktf.booleanToHclTerraform(struct.readOnly),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        volume_id: {
            value: cdktf.stringToHclTerraform(struct.volumeId),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeAwsElasticBlockStoreOutputReference extends cdktf.ComplexObject {
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
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._partition !== undefined) {
            hasAnyValues = true;
            internalValueResult.partition = this._partition;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._volumeId !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeId = this._volumeId;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsType = undefined;
            this._partition = undefined;
            this._readOnly = undefined;
            this._volumeId = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsType = value.fsType;
            this._partition = value.partition;
            this._readOnly = value.readOnly;
            this._volumeId = value.volumeId;
        }
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // partition - computed: false, optional: true, required: false
    _partition;
    get partition() {
        return this.getNumberAttribute('partition');
    }
    set partition(value) {
        this._partition = value;
    }
    resetPartition() {
        this._partition = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get partitionInput() {
        return this._partition;
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
    // volume_id - computed: false, optional: false, required: true
    _volumeId;
    get volumeId() {
        return this.getStringAttribute('volume_id');
    }
    set volumeId(value) {
        this._volumeId = value;
    }
    // Temporarily expose input value. Use with caution.
    get volumeIdInput() {
        return this._volumeId;
    }
}
export function deploymentSpecTemplateSpecVolumeAzureDiskToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        caching_mode: cdktf.stringToTerraform(struct.cachingMode),
        data_disk_uri: cdktf.stringToTerraform(struct.dataDiskUri),
        disk_name: cdktf.stringToTerraform(struct.diskName),
        fs_type: cdktf.stringToTerraform(struct.fsType),
        kind: cdktf.stringToTerraform(struct.kind),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
    };
}
export function deploymentSpecTemplateSpecVolumeAzureDiskToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        caching_mode: {
            value: cdktf.stringToHclTerraform(struct.cachingMode),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        data_disk_uri: {
            value: cdktf.stringToHclTerraform(struct.dataDiskUri),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        disk_name: {
            value: cdktf.stringToHclTerraform(struct.diskName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        kind: {
            value: cdktf.stringToHclTerraform(struct.kind),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeAzureDiskOutputReference extends cdktf.ComplexObject {
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
        if (this._cachingMode !== undefined) {
            hasAnyValues = true;
            internalValueResult.cachingMode = this._cachingMode;
        }
        if (this._dataDiskUri !== undefined) {
            hasAnyValues = true;
            internalValueResult.dataDiskUri = this._dataDiskUri;
        }
        if (this._diskName !== undefined) {
            hasAnyValues = true;
            internalValueResult.diskName = this._diskName;
        }
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._kind !== undefined) {
            hasAnyValues = true;
            internalValueResult.kind = this._kind;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._cachingMode = undefined;
            this._dataDiskUri = undefined;
            this._diskName = undefined;
            this._fsType = undefined;
            this._kind = undefined;
            this._readOnly = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._cachingMode = value.cachingMode;
            this._dataDiskUri = value.dataDiskUri;
            this._diskName = value.diskName;
            this._fsType = value.fsType;
            this._kind = value.kind;
            this._readOnly = value.readOnly;
        }
    }
    // caching_mode - computed: false, optional: false, required: true
    _cachingMode;
    get cachingMode() {
        return this.getStringAttribute('caching_mode');
    }
    set cachingMode(value) {
        this._cachingMode = value;
    }
    // Temporarily expose input value. Use with caution.
    get cachingModeInput() {
        return this._cachingMode;
    }
    // data_disk_uri - computed: false, optional: false, required: true
    _dataDiskUri;
    get dataDiskUri() {
        return this.getStringAttribute('data_disk_uri');
    }
    set dataDiskUri(value) {
        this._dataDiskUri = value;
    }
    // Temporarily expose input value. Use with caution.
    get dataDiskUriInput() {
        return this._dataDiskUri;
    }
    // disk_name - computed: false, optional: false, required: true
    _diskName;
    get diskName() {
        return this.getStringAttribute('disk_name');
    }
    set diskName(value) {
        this._diskName = value;
    }
    // Temporarily expose input value. Use with caution.
    get diskNameInput() {
        return this._diskName;
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // kind - computed: true, optional: true, required: false
    _kind;
    get kind() {
        return this.getStringAttribute('kind');
    }
    set kind(value) {
        this._kind = value;
    }
    resetKind() {
        this._kind = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get kindInput() {
        return this._kind;
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
}
export function deploymentSpecTemplateSpecVolumeAzureFileToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        secret_name: cdktf.stringToTerraform(struct.secretName),
        secret_namespace: cdktf.stringToTerraform(struct.secretNamespace),
        share_name: cdktf.stringToTerraform(struct.shareName),
    };
}
export function deploymentSpecTemplateSpecVolumeAzureFileToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        read_only: {
            value: cdktf.booleanToHclTerraform(struct.readOnly),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        secret_name: {
            value: cdktf.stringToHclTerraform(struct.secretName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        secret_namespace: {
            value: cdktf.stringToHclTerraform(struct.secretNamespace),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        share_name: {
            value: cdktf.stringToHclTerraform(struct.shareName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeAzureFileOutputReference extends cdktf.ComplexObject {
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
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._secretName !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretName = this._secretName;
        }
        if (this._secretNamespace !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretNamespace = this._secretNamespace;
        }
        if (this._shareName !== undefined) {
            hasAnyValues = true;
            internalValueResult.shareName = this._shareName;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._readOnly = undefined;
            this._secretName = undefined;
            this._secretNamespace = undefined;
            this._shareName = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._readOnly = value.readOnly;
            this._secretName = value.secretName;
            this._secretNamespace = value.secretNamespace;
            this._shareName = value.shareName;
        }
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
    // secret_name - computed: false, optional: false, required: true
    _secretName;
    get secretName() {
        return this.getStringAttribute('secret_name');
    }
    set secretName(value) {
        this._secretName = value;
    }
    // Temporarily expose input value. Use with caution.
    get secretNameInput() {
        return this._secretName;
    }
    // secret_namespace - computed: false, optional: true, required: false
    _secretNamespace;
    get secretNamespace() {
        return this.getStringAttribute('secret_namespace');
    }
    set secretNamespace(value) {
        this._secretNamespace = value;
    }
    resetSecretNamespace() {
        this._secretNamespace = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretNamespaceInput() {
        return this._secretNamespace;
    }
    // share_name - computed: false, optional: false, required: true
    _shareName;
    get shareName() {
        return this.getStringAttribute('share_name');
    }
    set shareName(value) {
        this._shareName = value;
    }
    // Temporarily expose input value. Use with caution.
    get shareNameInput() {
        return this._shareName;
    }
}
export function deploymentSpecTemplateSpecVolumeCephFsSecretRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        namespace: cdktf.stringToTerraform(struct.namespace),
    };
}
export function deploymentSpecTemplateSpecVolumeCephFsSecretRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeCephFsSecretRefOutputReference extends cdktf.ComplexObject {
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
        if (this._namespace !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespace = this._namespace;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
            this._namespace = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
            this._namespace = value.namespace;
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
    // namespace - computed: true, optional: true, required: false
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
}
export function deploymentSpecTemplateSpecVolumeCephFsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        monitors: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.monitors),
        path: cdktf.stringToTerraform(struct.path),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        secret_file: cdktf.stringToTerraform(struct.secretFile),
        user: cdktf.stringToTerraform(struct.user),
        secret_ref: deploymentSpecTemplateSpecVolumeCephFsSecretRefToTerraform(struct.secretRef),
    };
}
export function deploymentSpecTemplateSpecVolumeCephFsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        monitors: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.monitors),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
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
        secret_file: {
            value: cdktf.stringToHclTerraform(struct.secretFile),
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
        secret_ref: {
            value: deploymentSpecTemplateSpecVolumeCephFsSecretRefToHclTerraform(struct.secretRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeCephFsSecretRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeCephFsOutputReference extends cdktf.ComplexObject {
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
        if (this._monitors !== undefined) {
            hasAnyValues = true;
            internalValueResult.monitors = this._monitors;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._secretFile !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretFile = this._secretFile;
        }
        if (this._user !== undefined) {
            hasAnyValues = true;
            internalValueResult.user = this._user;
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
            this._monitors = undefined;
            this._path = undefined;
            this._readOnly = undefined;
            this._secretFile = undefined;
            this._user = undefined;
            this._secretRef.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._monitors = value.monitors;
            this._path = value.path;
            this._readOnly = value.readOnly;
            this._secretFile = value.secretFile;
            this._user = value.user;
            this._secretRef.internalValue = value.secretRef;
        }
    }
    // monitors - computed: false, optional: false, required: true
    _monitors;
    get monitors() {
        return cdktf.Fn.tolist(this.getListAttribute('monitors'));
    }
    set monitors(value) {
        this._monitors = value;
    }
    // Temporarily expose input value. Use with caution.
    get monitorsInput() {
        return this._monitors;
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
    // secret_file - computed: false, optional: true, required: false
    _secretFile;
    get secretFile() {
        return this.getStringAttribute('secret_file');
    }
    set secretFile(value) {
        this._secretFile = value;
    }
    resetSecretFile() {
        this._secretFile = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretFileInput() {
        return this._secretFile;
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
    // secret_ref - computed: false, optional: true, required: false
    _secretRef = new DeploymentSpecTemplateSpecVolumeCephFsSecretRefOutputReference(this, "secret_ref");
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
export function deploymentSpecTemplateSpecVolumeCinderToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_type: cdktf.stringToTerraform(struct.fsType),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        volume_id: cdktf.stringToTerraform(struct.volumeId),
    };
}
export function deploymentSpecTemplateSpecVolumeCinderToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
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
        volume_id: {
            value: cdktf.stringToHclTerraform(struct.volumeId),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeCinderOutputReference extends cdktf.ComplexObject {
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
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._volumeId !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeId = this._volumeId;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsType = undefined;
            this._readOnly = undefined;
            this._volumeId = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsType = value.fsType;
            this._readOnly = value.readOnly;
            this._volumeId = value.volumeId;
        }
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
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
    // volume_id - computed: false, optional: false, required: true
    _volumeId;
    get volumeId() {
        return this.getStringAttribute('volume_id');
    }
    set volumeId(value) {
        this._volumeId = value;
    }
    // Temporarily expose input value. Use with caution.
    get volumeIdInput() {
        return this._volumeId;
    }
}
export function deploymentSpecTemplateSpecVolumeConfigMapItemsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        mode: cdktf.stringToTerraform(struct.mode),
        path: cdktf.stringToTerraform(struct.path),
    };
}
export function deploymentSpecTemplateSpecVolumeConfigMapItemsToHclTerraform(struct) {
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
        mode: {
            value: cdktf.stringToHclTerraform(struct.mode),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeConfigMapItemsOutputReference extends cdktf.ComplexObject {
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
        if (this._mode !== undefined) {
            hasAnyValues = true;
            internalValueResult.mode = this._mode;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._key = undefined;
            this._mode = undefined;
            this._path = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._key = value.key;
            this._mode = value.mode;
            this._path = value.path;
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
    // mode - computed: false, optional: true, required: false
    _mode;
    get mode() {
        return this.getStringAttribute('mode');
    }
    set mode(value) {
        this._mode = value;
    }
    resetMode() {
        this._mode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get modeInput() {
        return this._mode;
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
}
export class DeploymentSpecTemplateSpecVolumeConfigMapItemsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeConfigMapItemsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeConfigMapToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        default_mode: cdktf.stringToTerraform(struct.defaultMode),
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
        items: cdktf.listMapper(deploymentSpecTemplateSpecVolumeConfigMapItemsToTerraform, true)(struct.items),
    };
}
export function deploymentSpecTemplateSpecVolumeConfigMapToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        default_mode: {
            value: cdktf.stringToHclTerraform(struct.defaultMode),
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
        items: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeConfigMapItemsToHclTerraform, true)(struct.items),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeConfigMapItemsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeConfigMapOutputReference extends cdktf.ComplexObject {
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
        if (this._defaultMode !== undefined) {
            hasAnyValues = true;
            internalValueResult.defaultMode = this._defaultMode;
        }
        if (this._name !== undefined) {
            hasAnyValues = true;
            internalValueResult.name = this._name;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        if (this._items?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.items = this._items?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._defaultMode = undefined;
            this._name = undefined;
            this._optional = undefined;
            this._items.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._defaultMode = value.defaultMode;
            this._name = value.name;
            this._optional = value.optional;
            this._items.internalValue = value.items;
        }
    }
    // default_mode - computed: false, optional: true, required: false
    _defaultMode;
    get defaultMode() {
        return this.getStringAttribute('default_mode');
    }
    set defaultMode(value) {
        this._defaultMode = value;
    }
    resetDefaultMode() {
        this._defaultMode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get defaultModeInput() {
        return this._defaultMode;
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
    // items - computed: false, optional: true, required: false
    _items = new DeploymentSpecTemplateSpecVolumeConfigMapItemsList(this, "items", false);
    get items() {
        return this._items;
    }
    putItems(value) {
        this._items.internalValue = value;
    }
    resetItems() {
        this._items.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get itemsInput() {
        return this._items.internalValue;
    }
}
export function deploymentSpecTemplateSpecVolumeCsiNodePublishSecretRefToTerraform(struct) {
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
export function deploymentSpecTemplateSpecVolumeCsiNodePublishSecretRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeCsiNodePublishSecretRefOutputReference extends cdktf.ComplexObject {
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
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
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
}
export function deploymentSpecTemplateSpecVolumeCsiToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        driver: cdktf.stringToTerraform(struct.driver),
        fs_type: cdktf.stringToTerraform(struct.fsType),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        volume_attributes: cdktf.hashMapper(cdktf.stringToTerraform)(struct.volumeAttributes),
        node_publish_secret_ref: deploymentSpecTemplateSpecVolumeCsiNodePublishSecretRefToTerraform(struct.nodePublishSecretRef),
    };
}
export function deploymentSpecTemplateSpecVolumeCsiToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        driver: {
            value: cdktf.stringToHclTerraform(struct.driver),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
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
        volume_attributes: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.volumeAttributes),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        node_publish_secret_ref: {
            value: deploymentSpecTemplateSpecVolumeCsiNodePublishSecretRefToHclTerraform(struct.nodePublishSecretRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeCsiNodePublishSecretRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeCsiOutputReference extends cdktf.ComplexObject {
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
        if (this._driver !== undefined) {
            hasAnyValues = true;
            internalValueResult.driver = this._driver;
        }
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._volumeAttributes !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeAttributes = this._volumeAttributes;
        }
        if (this._nodePublishSecretRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodePublishSecretRef = this._nodePublishSecretRef?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._driver = undefined;
            this._fsType = undefined;
            this._readOnly = undefined;
            this._volumeAttributes = undefined;
            this._nodePublishSecretRef.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._driver = value.driver;
            this._fsType = value.fsType;
            this._readOnly = value.readOnly;
            this._volumeAttributes = value.volumeAttributes;
            this._nodePublishSecretRef.internalValue = value.nodePublishSecretRef;
        }
    }
    // driver - computed: false, optional: false, required: true
    _driver;
    get driver() {
        return this.getStringAttribute('driver');
    }
    set driver(value) {
        this._driver = value;
    }
    // Temporarily expose input value. Use with caution.
    get driverInput() {
        return this._driver;
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
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
    // volume_attributes - computed: false, optional: true, required: false
    _volumeAttributes;
    get volumeAttributes() {
        return this.getStringMapAttribute('volume_attributes');
    }
    set volumeAttributes(value) {
        this._volumeAttributes = value;
    }
    resetVolumeAttributes() {
        this._volumeAttributes = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get volumeAttributesInput() {
        return this._volumeAttributes;
    }
    // node_publish_secret_ref - computed: false, optional: true, required: false
    _nodePublishSecretRef = new DeploymentSpecTemplateSpecVolumeCsiNodePublishSecretRefOutputReference(this, "node_publish_secret_ref");
    get nodePublishSecretRef() {
        return this._nodePublishSecretRef;
    }
    putNodePublishSecretRef(value) {
        this._nodePublishSecretRef.internalValue = value;
    }
    resetNodePublishSecretRef() {
        this._nodePublishSecretRef.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodePublishSecretRefInput() {
        return this._nodePublishSecretRef.internalValue;
    }
}
export function deploymentSpecTemplateSpecVolumeDownwardApiItemsFieldRefToTerraform(struct) {
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
export function deploymentSpecTemplateSpecVolumeDownwardApiItemsFieldRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeDownwardApiItemsFieldRefOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecVolumeDownwardApiItemsResourceFieldRefToTerraform(struct) {
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
export function deploymentSpecTemplateSpecVolumeDownwardApiItemsResourceFieldRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeDownwardApiItemsResourceFieldRefOutputReference extends cdktf.ComplexObject {
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
    // container_name - computed: false, optional: false, required: true
    _containerName;
    get containerName() {
        return this.getStringAttribute('container_name');
    }
    set containerName(value) {
        this._containerName = value;
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
export function deploymentSpecTemplateSpecVolumeDownwardApiItemsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        mode: cdktf.stringToTerraform(struct.mode),
        path: cdktf.stringToTerraform(struct.path),
        field_ref: deploymentSpecTemplateSpecVolumeDownwardApiItemsFieldRefToTerraform(struct.fieldRef),
        resource_field_ref: deploymentSpecTemplateSpecVolumeDownwardApiItemsResourceFieldRefToTerraform(struct.resourceFieldRef),
    };
}
export function deploymentSpecTemplateSpecVolumeDownwardApiItemsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        mode: {
            value: cdktf.stringToHclTerraform(struct.mode),
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
        field_ref: {
            value: deploymentSpecTemplateSpecVolumeDownwardApiItemsFieldRefToHclTerraform(struct.fieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeDownwardApiItemsFieldRefList",
        },
        resource_field_ref: {
            value: deploymentSpecTemplateSpecVolumeDownwardApiItemsResourceFieldRefToHclTerraform(struct.resourceFieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeDownwardApiItemsResourceFieldRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeDownwardApiItemsOutputReference extends cdktf.ComplexObject {
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
        if (this._mode !== undefined) {
            hasAnyValues = true;
            internalValueResult.mode = this._mode;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._fieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.fieldRef = this._fieldRef?.internalValue;
        }
        if (this._resourceFieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.resourceFieldRef = this._resourceFieldRef?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._mode = undefined;
            this._path = undefined;
            this._fieldRef.internalValue = undefined;
            this._resourceFieldRef.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._mode = value.mode;
            this._path = value.path;
            this._fieldRef.internalValue = value.fieldRef;
            this._resourceFieldRef.internalValue = value.resourceFieldRef;
        }
    }
    // mode - computed: false, optional: true, required: false
    _mode;
    get mode() {
        return this.getStringAttribute('mode');
    }
    set mode(value) {
        this._mode = value;
    }
    resetMode() {
        this._mode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get modeInput() {
        return this._mode;
    }
    // path - computed: false, optional: false, required: true
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // field_ref - computed: false, optional: false, required: true
    _fieldRef = new DeploymentSpecTemplateSpecVolumeDownwardApiItemsFieldRefOutputReference(this, "field_ref");
    get fieldRef() {
        return this._fieldRef;
    }
    putFieldRef(value) {
        this._fieldRef.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get fieldRefInput() {
        return this._fieldRef.internalValue;
    }
    // resource_field_ref - computed: false, optional: true, required: false
    _resourceFieldRef = new DeploymentSpecTemplateSpecVolumeDownwardApiItemsResourceFieldRefOutputReference(this, "resource_field_ref");
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
}
export class DeploymentSpecTemplateSpecVolumeDownwardApiItemsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeDownwardApiItemsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeDownwardApiToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        default_mode: cdktf.stringToTerraform(struct.defaultMode),
        items: cdktf.listMapper(deploymentSpecTemplateSpecVolumeDownwardApiItemsToTerraform, true)(struct.items),
    };
}
export function deploymentSpecTemplateSpecVolumeDownwardApiToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        default_mode: {
            value: cdktf.stringToHclTerraform(struct.defaultMode),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        items: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeDownwardApiItemsToHclTerraform, true)(struct.items),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeDownwardApiItemsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeDownwardApiOutputReference extends cdktf.ComplexObject {
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
        if (this._defaultMode !== undefined) {
            hasAnyValues = true;
            internalValueResult.defaultMode = this._defaultMode;
        }
        if (this._items?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.items = this._items?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._defaultMode = undefined;
            this._items.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._defaultMode = value.defaultMode;
            this._items.internalValue = value.items;
        }
    }
    // default_mode - computed: false, optional: true, required: false
    _defaultMode;
    get defaultMode() {
        return this.getStringAttribute('default_mode');
    }
    set defaultMode(value) {
        this._defaultMode = value;
    }
    resetDefaultMode() {
        this._defaultMode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get defaultModeInput() {
        return this._defaultMode;
    }
    // items - computed: false, optional: true, required: false
    _items = new DeploymentSpecTemplateSpecVolumeDownwardApiItemsList(this, "items", false);
    get items() {
        return this._items;
    }
    putItems(value) {
        this._items.internalValue = value;
    }
    resetItems() {
        this._items.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get itemsInput() {
        return this._items.internalValue;
    }
}
export function deploymentSpecTemplateSpecVolumeEmptyDirToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        medium: cdktf.stringToTerraform(struct.medium),
        size_limit: cdktf.stringToTerraform(struct.sizeLimit),
    };
}
export function deploymentSpecTemplateSpecVolumeEmptyDirToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        medium: {
            value: cdktf.stringToHclTerraform(struct.medium),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        size_limit: {
            value: cdktf.stringToHclTerraform(struct.sizeLimit),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeEmptyDirOutputReference extends cdktf.ComplexObject {
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
        if (this._medium !== undefined) {
            hasAnyValues = true;
            internalValueResult.medium = this._medium;
        }
        if (this._sizeLimit !== undefined) {
            hasAnyValues = true;
            internalValueResult.sizeLimit = this._sizeLimit;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._medium = undefined;
            this._sizeLimit = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._medium = value.medium;
            this._sizeLimit = value.sizeLimit;
        }
    }
    // medium - computed: false, optional: true, required: false
    _medium;
    get medium() {
        return this.getStringAttribute('medium');
    }
    set medium(value) {
        this._medium = value;
    }
    resetMedium() {
        this._medium = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get mediumInput() {
        return this._medium;
    }
    // size_limit - computed: false, optional: true, required: false
    _sizeLimit;
    get sizeLimit() {
        return this.getStringAttribute('size_limit');
    }
    set sizeLimit(value) {
        this._sizeLimit = value;
    }
    resetSizeLimit() {
        this._sizeLimit = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get sizeLimitInput() {
        return this._sizeLimit;
    }
}
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateMetadataToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        annotations: cdktf.hashMapper(cdktf.stringToTerraform)(struct.annotations),
        labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.labels),
    };
}
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateMetadataToHclTerraform(struct) {
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
        labels: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.labels),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateMetadataOutputReference extends cdktf.ComplexObject {
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
        if (this._labels !== undefined) {
            hasAnyValues = true;
            internalValueResult.labels = this._labels;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._annotations = undefined;
            this._labels = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._annotations = value.annotations;
            this._labels = value.labels;
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
}
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecResourcesToTerraform(struct) {
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
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecResourcesToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecResourcesOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsToTerraform(struct) {
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
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsOutputReference extends cdktf.ComplexObject {
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
export class DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        match_labels: cdktf.hashMapper(cdktf.stringToTerraform)(struct.matchLabels),
        match_expressions: cdktf.listMapper(deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsToTerraform, true)(struct.matchExpressions),
    };
}
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorToHclTerraform(struct) {
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
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsToHclTerraform, true)(struct.matchExpressions),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorOutputReference extends cdktf.ComplexObject {
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
    _matchExpressions = new DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorMatchExpressionsList(this, "match_expressions", false);
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
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecToTerraform(struct) {
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
        resources: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecResourcesToTerraform(struct.resources),
        selector: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorToTerraform(struct.selector),
    };
}
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecToHclTerraform(struct) {
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
            value: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecResourcesToHclTerraform(struct.resources),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecResourcesList",
        },
        selector: {
            value: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorToHclTerraform(struct.selector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecOutputReference extends cdktf.ComplexObject {
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
    _resources = new DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecResourcesOutputReference(this, "resources");
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
    _selector = new DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecSelectorOutputReference(this, "selector");
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
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        metadata: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateMetadataToTerraform(struct.metadata),
        spec: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecToTerraform(struct.spec),
    };
}
export function deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        metadata: {
            value: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateMetadataToHclTerraform(struct.metadata),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateMetadataList",
        },
        spec: {
            value: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecToHclTerraform(struct.spec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateOutputReference extends cdktf.ComplexObject {
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
        if (this._metadata?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.metadata = this._metadata?.internalValue;
        }
        if (this._spec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.spec = this._spec?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._metadata.internalValue = undefined;
            this._spec.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._metadata.internalValue = value.metadata;
            this._spec.internalValue = value.spec;
        }
    }
    // metadata - computed: false, optional: true, required: false
    _metadata = new DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateMetadataOutputReference(this, "metadata");
    get metadata() {
        return this._metadata;
    }
    putMetadata(value) {
        this._metadata.internalValue = value;
    }
    resetMetadata() {
        this._metadata.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get metadataInput() {
        return this._metadata.internalValue;
    }
    // spec - computed: false, optional: false, required: true
    _spec = new DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateSpecOutputReference(this, "spec");
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
}
export function deploymentSpecTemplateSpecVolumeEphemeralToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        volume_claim_template: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateToTerraform(struct.volumeClaimTemplate),
    };
}
export function deploymentSpecTemplateSpecVolumeEphemeralToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        volume_claim_template: {
            value: deploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateToHclTerraform(struct.volumeClaimTemplate),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeEphemeralOutputReference extends cdktf.ComplexObject {
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
        if (this._volumeClaimTemplate?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumeClaimTemplate = this._volumeClaimTemplate?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._volumeClaimTemplate.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._volumeClaimTemplate.internalValue = value.volumeClaimTemplate;
        }
    }
    // volume_claim_template - computed: false, optional: false, required: true
    _volumeClaimTemplate = new DeploymentSpecTemplateSpecVolumeEphemeralVolumeClaimTemplateOutputReference(this, "volume_claim_template");
    get volumeClaimTemplate() {
        return this._volumeClaimTemplate;
    }
    putVolumeClaimTemplate(value) {
        this._volumeClaimTemplate.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get volumeClaimTemplateInput() {
        return this._volumeClaimTemplate.internalValue;
    }
}
export function deploymentSpecTemplateSpecVolumeFcToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_type: cdktf.stringToTerraform(struct.fsType),
        lun: cdktf.numberToTerraform(struct.lun),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        target_ww_ns: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.targetWwNs),
    };
}
export function deploymentSpecTemplateSpecVolumeFcToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        lun: {
            value: cdktf.numberToHclTerraform(struct.lun),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        read_only: {
            value: cdktf.booleanToHclTerraform(struct.readOnly),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        target_ww_ns: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.targetWwNs),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeFcOutputReference extends cdktf.ComplexObject {
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
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._lun !== undefined) {
            hasAnyValues = true;
            internalValueResult.lun = this._lun;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._targetWwNs !== undefined) {
            hasAnyValues = true;
            internalValueResult.targetWwNs = this._targetWwNs;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsType = undefined;
            this._lun = undefined;
            this._readOnly = undefined;
            this._targetWwNs = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsType = value.fsType;
            this._lun = value.lun;
            this._readOnly = value.readOnly;
            this._targetWwNs = value.targetWwNs;
        }
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // lun - computed: false, optional: false, required: true
    _lun;
    get lun() {
        return this.getNumberAttribute('lun');
    }
    set lun(value) {
        this._lun = value;
    }
    // Temporarily expose input value. Use with caution.
    get lunInput() {
        return this._lun;
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
    // target_ww_ns - computed: false, optional: false, required: true
    _targetWwNs;
    get targetWwNs() {
        return cdktf.Fn.tolist(this.getListAttribute('target_ww_ns'));
    }
    set targetWwNs(value) {
        this._targetWwNs = value;
    }
    // Temporarily expose input value. Use with caution.
    get targetWwNsInput() {
        return this._targetWwNs;
    }
}
export function deploymentSpecTemplateSpecVolumeFlexVolumeSecretRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        namespace: cdktf.stringToTerraform(struct.namespace),
    };
}
export function deploymentSpecTemplateSpecVolumeFlexVolumeSecretRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeFlexVolumeSecretRefOutputReference extends cdktf.ComplexObject {
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
        if (this._namespace !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespace = this._namespace;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
            this._namespace = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
            this._namespace = value.namespace;
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
    // namespace - computed: true, optional: true, required: false
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
}
export function deploymentSpecTemplateSpecVolumeFlexVolumeToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        driver: cdktf.stringToTerraform(struct.driver),
        fs_type: cdktf.stringToTerraform(struct.fsType),
        options: cdktf.hashMapper(cdktf.stringToTerraform)(struct.options),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        secret_ref: deploymentSpecTemplateSpecVolumeFlexVolumeSecretRefToTerraform(struct.secretRef),
    };
}
export function deploymentSpecTemplateSpecVolumeFlexVolumeToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        driver: {
            value: cdktf.stringToHclTerraform(struct.driver),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        options: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.options),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        read_only: {
            value: cdktf.booleanToHclTerraform(struct.readOnly),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        secret_ref: {
            value: deploymentSpecTemplateSpecVolumeFlexVolumeSecretRefToHclTerraform(struct.secretRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeFlexVolumeSecretRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeFlexVolumeOutputReference extends cdktf.ComplexObject {
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
        if (this._driver !== undefined) {
            hasAnyValues = true;
            internalValueResult.driver = this._driver;
        }
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._options !== undefined) {
            hasAnyValues = true;
            internalValueResult.options = this._options;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
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
            this._driver = undefined;
            this._fsType = undefined;
            this._options = undefined;
            this._readOnly = undefined;
            this._secretRef.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._driver = value.driver;
            this._fsType = value.fsType;
            this._options = value.options;
            this._readOnly = value.readOnly;
            this._secretRef.internalValue = value.secretRef;
        }
    }
    // driver - computed: false, optional: false, required: true
    _driver;
    get driver() {
        return this.getStringAttribute('driver');
    }
    set driver(value) {
        this._driver = value;
    }
    // Temporarily expose input value. Use with caution.
    get driverInput() {
        return this._driver;
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // options - computed: false, optional: true, required: false
    _options;
    get options() {
        return this.getStringMapAttribute('options');
    }
    set options(value) {
        this._options = value;
    }
    resetOptions() {
        this._options = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get optionsInput() {
        return this._options;
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
    // secret_ref - computed: false, optional: true, required: false
    _secretRef = new DeploymentSpecTemplateSpecVolumeFlexVolumeSecretRefOutputReference(this, "secret_ref");
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
export function deploymentSpecTemplateSpecVolumeFlockerToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        dataset_name: cdktf.stringToTerraform(struct.datasetName),
        dataset_uuid: cdktf.stringToTerraform(struct.datasetUuid),
    };
}
export function deploymentSpecTemplateSpecVolumeFlockerToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        dataset_name: {
            value: cdktf.stringToHclTerraform(struct.datasetName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        dataset_uuid: {
            value: cdktf.stringToHclTerraform(struct.datasetUuid),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeFlockerOutputReference extends cdktf.ComplexObject {
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
        if (this._datasetName !== undefined) {
            hasAnyValues = true;
            internalValueResult.datasetName = this._datasetName;
        }
        if (this._datasetUuid !== undefined) {
            hasAnyValues = true;
            internalValueResult.datasetUuid = this._datasetUuid;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._datasetName = undefined;
            this._datasetUuid = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._datasetName = value.datasetName;
            this._datasetUuid = value.datasetUuid;
        }
    }
    // dataset_name - computed: false, optional: true, required: false
    _datasetName;
    get datasetName() {
        return this.getStringAttribute('dataset_name');
    }
    set datasetName(value) {
        this._datasetName = value;
    }
    resetDatasetName() {
        this._datasetName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get datasetNameInput() {
        return this._datasetName;
    }
    // dataset_uuid - computed: false, optional: true, required: false
    _datasetUuid;
    get datasetUuid() {
        return this.getStringAttribute('dataset_uuid');
    }
    set datasetUuid(value) {
        this._datasetUuid = value;
    }
    resetDatasetUuid() {
        this._datasetUuid = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get datasetUuidInput() {
        return this._datasetUuid;
    }
}
export function deploymentSpecTemplateSpecVolumeGcePersistentDiskToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_type: cdktf.stringToTerraform(struct.fsType),
        partition: cdktf.numberToTerraform(struct.partition),
        pd_name: cdktf.stringToTerraform(struct.pdName),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
    };
}
export function deploymentSpecTemplateSpecVolumeGcePersistentDiskToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        partition: {
            value: cdktf.numberToHclTerraform(struct.partition),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        pd_name: {
            value: cdktf.stringToHclTerraform(struct.pdName),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeGcePersistentDiskOutputReference extends cdktf.ComplexObject {
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
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._partition !== undefined) {
            hasAnyValues = true;
            internalValueResult.partition = this._partition;
        }
        if (this._pdName !== undefined) {
            hasAnyValues = true;
            internalValueResult.pdName = this._pdName;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsType = undefined;
            this._partition = undefined;
            this._pdName = undefined;
            this._readOnly = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsType = value.fsType;
            this._partition = value.partition;
            this._pdName = value.pdName;
            this._readOnly = value.readOnly;
        }
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // partition - computed: false, optional: true, required: false
    _partition;
    get partition() {
        return this.getNumberAttribute('partition');
    }
    set partition(value) {
        this._partition = value;
    }
    resetPartition() {
        this._partition = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get partitionInput() {
        return this._partition;
    }
    // pd_name - computed: false, optional: false, required: true
    _pdName;
    get pdName() {
        return this.getStringAttribute('pd_name');
    }
    set pdName(value) {
        this._pdName = value;
    }
    // Temporarily expose input value. Use with caution.
    get pdNameInput() {
        return this._pdName;
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
}
export function deploymentSpecTemplateSpecVolumeGitRepoToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        directory: cdktf.stringToTerraform(struct.directory),
        repository: cdktf.stringToTerraform(struct.repository),
        revision: cdktf.stringToTerraform(struct.revision),
    };
}
export function deploymentSpecTemplateSpecVolumeGitRepoToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        directory: {
            value: cdktf.stringToHclTerraform(struct.directory),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        repository: {
            value: cdktf.stringToHclTerraform(struct.repository),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        revision: {
            value: cdktf.stringToHclTerraform(struct.revision),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeGitRepoOutputReference extends cdktf.ComplexObject {
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
        if (this._directory !== undefined) {
            hasAnyValues = true;
            internalValueResult.directory = this._directory;
        }
        if (this._repository !== undefined) {
            hasAnyValues = true;
            internalValueResult.repository = this._repository;
        }
        if (this._revision !== undefined) {
            hasAnyValues = true;
            internalValueResult.revision = this._revision;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._directory = undefined;
            this._repository = undefined;
            this._revision = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._directory = value.directory;
            this._repository = value.repository;
            this._revision = value.revision;
        }
    }
    // directory - computed: false, optional: true, required: false
    _directory;
    get directory() {
        return this.getStringAttribute('directory');
    }
    set directory(value) {
        this._directory = value;
    }
    resetDirectory() {
        this._directory = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get directoryInput() {
        return this._directory;
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
    // revision - computed: false, optional: true, required: false
    _revision;
    get revision() {
        return this.getStringAttribute('revision');
    }
    set revision(value) {
        this._revision = value;
    }
    resetRevision() {
        this._revision = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get revisionInput() {
        return this._revision;
    }
}
export function deploymentSpecTemplateSpecVolumeGlusterfsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        endpoints_name: cdktf.stringToTerraform(struct.endpointsName),
        path: cdktf.stringToTerraform(struct.path),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
    };
}
export function deploymentSpecTemplateSpecVolumeGlusterfsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        endpoints_name: {
            value: cdktf.stringToHclTerraform(struct.endpointsName),
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
        read_only: {
            value: cdktf.booleanToHclTerraform(struct.readOnly),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeGlusterfsOutputReference extends cdktf.ComplexObject {
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
        if (this._endpointsName !== undefined) {
            hasAnyValues = true;
            internalValueResult.endpointsName = this._endpointsName;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._endpointsName = undefined;
            this._path = undefined;
            this._readOnly = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._endpointsName = value.endpointsName;
            this._path = value.path;
            this._readOnly = value.readOnly;
        }
    }
    // endpoints_name - computed: false, optional: false, required: true
    _endpointsName;
    get endpointsName() {
        return this.getStringAttribute('endpoints_name');
    }
    set endpointsName(value) {
        this._endpointsName = value;
    }
    // Temporarily expose input value. Use with caution.
    get endpointsNameInput() {
        return this._endpointsName;
    }
    // path - computed: false, optional: false, required: true
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
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
}
export function deploymentSpecTemplateSpecVolumeHostPathToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        path: cdktf.stringToTerraform(struct.path),
        type: cdktf.stringToTerraform(struct.type),
    };
}
export function deploymentSpecTemplateSpecVolumeHostPathToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
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
export class DeploymentSpecTemplateSpecVolumeHostPathOutputReference extends cdktf.ComplexObject {
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
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
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
            this._path = undefined;
            this._type = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._path = value.path;
            this._type = value.type;
        }
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
export function deploymentSpecTemplateSpecVolumeIscsiToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_type: cdktf.stringToTerraform(struct.fsType),
        iqn: cdktf.stringToTerraform(struct.iqn),
        iscsi_interface: cdktf.stringToTerraform(struct.iscsiInterface),
        lun: cdktf.numberToTerraform(struct.lun),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        target_portal: cdktf.stringToTerraform(struct.targetPortal),
    };
}
export function deploymentSpecTemplateSpecVolumeIscsiToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        iqn: {
            value: cdktf.stringToHclTerraform(struct.iqn),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        iscsi_interface: {
            value: cdktf.stringToHclTerraform(struct.iscsiInterface),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        lun: {
            value: cdktf.numberToHclTerraform(struct.lun),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        read_only: {
            value: cdktf.booleanToHclTerraform(struct.readOnly),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        target_portal: {
            value: cdktf.stringToHclTerraform(struct.targetPortal),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeIscsiOutputReference extends cdktf.ComplexObject {
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
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._iqn !== undefined) {
            hasAnyValues = true;
            internalValueResult.iqn = this._iqn;
        }
        if (this._iscsiInterface !== undefined) {
            hasAnyValues = true;
            internalValueResult.iscsiInterface = this._iscsiInterface;
        }
        if (this._lun !== undefined) {
            hasAnyValues = true;
            internalValueResult.lun = this._lun;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._targetPortal !== undefined) {
            hasAnyValues = true;
            internalValueResult.targetPortal = this._targetPortal;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsType = undefined;
            this._iqn = undefined;
            this._iscsiInterface = undefined;
            this._lun = undefined;
            this._readOnly = undefined;
            this._targetPortal = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsType = value.fsType;
            this._iqn = value.iqn;
            this._iscsiInterface = value.iscsiInterface;
            this._lun = value.lun;
            this._readOnly = value.readOnly;
            this._targetPortal = value.targetPortal;
        }
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // iqn - computed: false, optional: false, required: true
    _iqn;
    get iqn() {
        return this.getStringAttribute('iqn');
    }
    set iqn(value) {
        this._iqn = value;
    }
    // Temporarily expose input value. Use with caution.
    get iqnInput() {
        return this._iqn;
    }
    // iscsi_interface - computed: false, optional: true, required: false
    _iscsiInterface;
    get iscsiInterface() {
        return this.getStringAttribute('iscsi_interface');
    }
    set iscsiInterface(value) {
        this._iscsiInterface = value;
    }
    resetIscsiInterface() {
        this._iscsiInterface = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get iscsiInterfaceInput() {
        return this._iscsiInterface;
    }
    // lun - computed: false, optional: true, required: false
    _lun;
    get lun() {
        return this.getNumberAttribute('lun');
    }
    set lun(value) {
        this._lun = value;
    }
    resetLun() {
        this._lun = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get lunInput() {
        return this._lun;
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
    // target_portal - computed: false, optional: false, required: true
    _targetPortal;
    get targetPortal() {
        return this.getStringAttribute('target_portal');
    }
    set targetPortal(value) {
        this._targetPortal = value;
    }
    // Temporarily expose input value. Use with caution.
    get targetPortalInput() {
        return this._targetPortal;
    }
}
export function deploymentSpecTemplateSpecVolumeLocalToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        path: cdktf.stringToTerraform(struct.path),
    };
}
export function deploymentSpecTemplateSpecVolumeLocalToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeLocalOutputReference extends cdktf.ComplexObject {
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
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._path = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._path = value.path;
        }
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
}
export function deploymentSpecTemplateSpecVolumeNfsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        path: cdktf.stringToTerraform(struct.path),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        server: cdktf.stringToTerraform(struct.server),
    };
}
export function deploymentSpecTemplateSpecVolumeNfsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
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
        server: {
            value: cdktf.stringToHclTerraform(struct.server),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeNfsOutputReference extends cdktf.ComplexObject {
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
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._server !== undefined) {
            hasAnyValues = true;
            internalValueResult.server = this._server;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._path = undefined;
            this._readOnly = undefined;
            this._server = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._path = value.path;
            this._readOnly = value.readOnly;
            this._server = value.server;
        }
    }
    // path - computed: false, optional: false, required: true
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
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
    // server - computed: false, optional: false, required: true
    _server;
    get server() {
        return this.getStringAttribute('server');
    }
    set server(value) {
        this._server = value;
    }
    // Temporarily expose input value. Use with caution.
    get serverInput() {
        return this._server;
    }
}
export function deploymentSpecTemplateSpecVolumePersistentVolumeClaimToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        claim_name: cdktf.stringToTerraform(struct.claimName),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
    };
}
export function deploymentSpecTemplateSpecVolumePersistentVolumeClaimToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        claim_name: {
            value: cdktf.stringToHclTerraform(struct.claimName),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumePersistentVolumeClaimOutputReference extends cdktf.ComplexObject {
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
        if (this._claimName !== undefined) {
            hasAnyValues = true;
            internalValueResult.claimName = this._claimName;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._claimName = undefined;
            this._readOnly = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._claimName = value.claimName;
            this._readOnly = value.readOnly;
        }
    }
    // claim_name - computed: false, optional: true, required: false
    _claimName;
    get claimName() {
        return this.getStringAttribute('claim_name');
    }
    set claimName(value) {
        this._claimName = value;
    }
    resetClaimName() {
        this._claimName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get claimNameInput() {
        return this._claimName;
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
}
export function deploymentSpecTemplateSpecVolumePhotonPersistentDiskToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_type: cdktf.stringToTerraform(struct.fsType),
        pd_id: cdktf.stringToTerraform(struct.pdId),
    };
}
export function deploymentSpecTemplateSpecVolumePhotonPersistentDiskToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        pd_id: {
            value: cdktf.stringToHclTerraform(struct.pdId),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumePhotonPersistentDiskOutputReference extends cdktf.ComplexObject {
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
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._pdId !== undefined) {
            hasAnyValues = true;
            internalValueResult.pdId = this._pdId;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsType = undefined;
            this._pdId = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsType = value.fsType;
            this._pdId = value.pdId;
        }
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // pd_id - computed: false, optional: false, required: true
    _pdId;
    get pdId() {
        return this.getStringAttribute('pd_id');
    }
    set pdId(value) {
        this._pdId = value;
    }
    // Temporarily expose input value. Use with caution.
    get pdIdInput() {
        return this._pdId;
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        mode: cdktf.stringToTerraform(struct.mode),
        path: cdktf.stringToTerraform(struct.path),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsToHclTerraform(struct) {
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
        mode: {
            value: cdktf.stringToHclTerraform(struct.mode),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsOutputReference extends cdktf.ComplexObject {
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
        if (this._mode !== undefined) {
            hasAnyValues = true;
            internalValueResult.mode = this._mode;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._key = undefined;
            this._mode = undefined;
            this._path = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._key = value.key;
            this._mode = value.mode;
            this._path = value.path;
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
    // mode - computed: false, optional: true, required: false
    _mode;
    get mode() {
        return this.getStringAttribute('mode');
    }
    set mode(value) {
        this._mode = value;
    }
    resetMode() {
        this._mode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get modeInput() {
        return this._mode;
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
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
        items: cdktf.listMapper(deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsToTerraform, true)(struct.items),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapToHclTerraform(struct) {
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
        items: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsToHclTerraform, true)(struct.items),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapOutputReference extends cdktf.ComplexObject {
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
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        if (this._items?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.items = this._items?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._optional = undefined;
            this._items.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._name = value.name;
            this._optional = value.optional;
            this._items.internalValue = value.items;
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
    // items - computed: false, optional: true, required: false
    _items = new DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapItemsList(this, "items", false);
    get items() {
        return this._items;
    }
    putItems(value) {
        this._items.internalValue = value;
    }
    resetItems() {
        this._items.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get itemsInput() {
        return this._items.internalValue;
    }
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsFieldRefToTerraform(struct) {
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
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsFieldRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsFieldRefOutputReference extends cdktf.ComplexObject {
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
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsResourceFieldRefToTerraform(struct) {
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
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsResourceFieldRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsResourceFieldRefOutputReference extends cdktf.ComplexObject {
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
    // container_name - computed: false, optional: false, required: true
    _containerName;
    get containerName() {
        return this.getStringAttribute('container_name');
    }
    set containerName(value) {
        this._containerName = value;
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
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        mode: cdktf.stringToTerraform(struct.mode),
        path: cdktf.stringToTerraform(struct.path),
        field_ref: deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsFieldRefToTerraform(struct.fieldRef),
        resource_field_ref: deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsResourceFieldRefToTerraform(struct.resourceFieldRef),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        mode: {
            value: cdktf.stringToHclTerraform(struct.mode),
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
        field_ref: {
            value: deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsFieldRefToHclTerraform(struct.fieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsFieldRefList",
        },
        resource_field_ref: {
            value: deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsResourceFieldRefToHclTerraform(struct.resourceFieldRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsResourceFieldRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsOutputReference extends cdktf.ComplexObject {
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
        if (this._mode !== undefined) {
            hasAnyValues = true;
            internalValueResult.mode = this._mode;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        if (this._fieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.fieldRef = this._fieldRef?.internalValue;
        }
        if (this._resourceFieldRef?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.resourceFieldRef = this._resourceFieldRef?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._mode = undefined;
            this._path = undefined;
            this._fieldRef.internalValue = undefined;
            this._resourceFieldRef.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._mode = value.mode;
            this._path = value.path;
            this._fieldRef.internalValue = value.fieldRef;
            this._resourceFieldRef.internalValue = value.resourceFieldRef;
        }
    }
    // mode - computed: false, optional: true, required: false
    _mode;
    get mode() {
        return this.getStringAttribute('mode');
    }
    set mode(value) {
        this._mode = value;
    }
    resetMode() {
        this._mode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get modeInput() {
        return this._mode;
    }
    // path - computed: false, optional: false, required: true
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
    // field_ref - computed: false, optional: true, required: false
    _fieldRef = new DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsFieldRefOutputReference(this, "field_ref");
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
    _resourceFieldRef = new DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsResourceFieldRefOutputReference(this, "resource_field_ref");
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
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        items: cdktf.listMapper(deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsToTerraform, true)(struct.items),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        items: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsToHclTerraform, true)(struct.items),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiOutputReference extends cdktf.ComplexObject {
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
        if (this._items?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.items = this._items?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._items.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._items.internalValue = value.items;
        }
    }
    // items - computed: false, optional: true, required: false
    _items = new DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiItemsList(this, "items", false);
    get items() {
        return this._items;
    }
    putItems(value) {
        this._items.internalValue = value;
    }
    resetItems() {
        this._items.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get itemsInput() {
        return this._items.internalValue;
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        mode: cdktf.stringToTerraform(struct.mode),
        path: cdktf.stringToTerraform(struct.path),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsToHclTerraform(struct) {
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
        mode: {
            value: cdktf.stringToHclTerraform(struct.mode),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsOutputReference extends cdktf.ComplexObject {
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
        if (this._mode !== undefined) {
            hasAnyValues = true;
            internalValueResult.mode = this._mode;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._key = undefined;
            this._mode = undefined;
            this._path = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._key = value.key;
            this._mode = value.mode;
            this._path = value.path;
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
    // mode - computed: false, optional: true, required: false
    _mode;
    get mode() {
        return this.getStringAttribute('mode');
    }
    set mode(value) {
        this._mode = value;
    }
    resetMode() {
        this._mode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get modeInput() {
        return this._mode;
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
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesSecretToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        optional: cdktf.booleanToTerraform(struct.optional),
        items: cdktf.listMapper(deploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsToTerraform, true)(struct.items),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesSecretToHclTerraform(struct) {
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
        items: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsToHclTerraform, true)(struct.items),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretOutputReference extends cdktf.ComplexObject {
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
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        if (this._items?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.items = this._items?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._optional = undefined;
            this._items.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._name = value.name;
            this._optional = value.optional;
            this._items.internalValue = value.items;
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
    // items - computed: false, optional: true, required: false
    _items = new DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretItemsList(this, "items", false);
    get items() {
        return this._items;
    }
    putItems(value) {
        this._items.internalValue = value;
    }
    resetItems() {
        this._items.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get itemsInput() {
        return this._items.internalValue;
    }
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesServiceAccountTokenToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        audience: cdktf.stringToTerraform(struct.audience),
        expiration_seconds: cdktf.numberToTerraform(struct.expirationSeconds),
        path: cdktf.stringToTerraform(struct.path),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesServiceAccountTokenToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        audience: {
            value: cdktf.stringToHclTerraform(struct.audience),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        expiration_seconds: {
            value: cdktf.numberToHclTerraform(struct.expirationSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        path: {
            value: cdktf.stringToHclTerraform(struct.path),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesServiceAccountTokenOutputReference extends cdktf.ComplexObject {
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
        if (this._audience !== undefined) {
            hasAnyValues = true;
            internalValueResult.audience = this._audience;
        }
        if (this._expirationSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.expirationSeconds = this._expirationSeconds;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._audience = undefined;
            this._expirationSeconds = undefined;
            this._path = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._audience = value.audience;
            this._expirationSeconds = value.expirationSeconds;
            this._path = value.path;
        }
    }
    // audience - computed: false, optional: true, required: false
    _audience;
    get audience() {
        return this.getStringAttribute('audience');
    }
    set audience(value) {
        this._audience = value;
    }
    resetAudience() {
        this._audience = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get audienceInput() {
        return this._audience;
    }
    // expiration_seconds - computed: false, optional: true, required: false
    _expirationSeconds;
    get expirationSeconds() {
        return this.getNumberAttribute('expiration_seconds');
    }
    set expirationSeconds(value) {
        this._expirationSeconds = value;
    }
    resetExpirationSeconds() {
        this._expirationSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get expirationSecondsInput() {
        return this._expirationSeconds;
    }
    // path - computed: false, optional: false, required: true
    _path;
    get path() {
        return this.getStringAttribute('path');
    }
    set path(value) {
        this._path = value;
    }
    // Temporarily expose input value. Use with caution.
    get pathInput() {
        return this._path;
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        config_map: cdktf.listMapper(deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapToTerraform, true)(struct.configMap),
        downward_api: deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiToTerraform(struct.downwardApi),
        secret: cdktf.listMapper(deploymentSpecTemplateSpecVolumeProjectedSourcesSecretToTerraform, true)(struct.secret),
        service_account_token: deploymentSpecTemplateSpecVolumeProjectedSourcesServiceAccountTokenToTerraform(struct.serviceAccountToken),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedSourcesToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        config_map: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapToHclTerraform, true)(struct.configMap),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapList",
        },
        downward_api: {
            value: deploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiToHclTerraform(struct.downwardApi),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiList",
        },
        secret: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeProjectedSourcesSecretToHclTerraform, true)(struct.secret),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretList",
        },
        service_account_token: {
            value: deploymentSpecTemplateSpecVolumeProjectedSourcesServiceAccountTokenToHclTerraform(struct.serviceAccountToken),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesServiceAccountTokenList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesOutputReference extends cdktf.ComplexObject {
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
        if (this._configMap?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.configMap = this._configMap?.internalValue;
        }
        if (this._downwardApi?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.downwardApi = this._downwardApi?.internalValue;
        }
        if (this._secret?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.secret = this._secret?.internalValue;
        }
        if (this._serviceAccountToken?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.serviceAccountToken = this._serviceAccountToken?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._configMap.internalValue = undefined;
            this._downwardApi.internalValue = undefined;
            this._secret.internalValue = undefined;
            this._serviceAccountToken.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._configMap.internalValue = value.configMap;
            this._downwardApi.internalValue = value.downwardApi;
            this._secret.internalValue = value.secret;
            this._serviceAccountToken.internalValue = value.serviceAccountToken;
        }
    }
    // config_map - computed: false, optional: true, required: false
    _configMap = new DeploymentSpecTemplateSpecVolumeProjectedSourcesConfigMapList(this, "config_map", false);
    get configMap() {
        return this._configMap;
    }
    putConfigMap(value) {
        this._configMap.internalValue = value;
    }
    resetConfigMap() {
        this._configMap.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configMapInput() {
        return this._configMap.internalValue;
    }
    // downward_api - computed: false, optional: true, required: false
    _downwardApi = new DeploymentSpecTemplateSpecVolumeProjectedSourcesDownwardApiOutputReference(this, "downward_api");
    get downwardApi() {
        return this._downwardApi;
    }
    putDownwardApi(value) {
        this._downwardApi.internalValue = value;
    }
    resetDownwardApi() {
        this._downwardApi.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get downwardApiInput() {
        return this._downwardApi.internalValue;
    }
    // secret - computed: false, optional: true, required: false
    _secret = new DeploymentSpecTemplateSpecVolumeProjectedSourcesSecretList(this, "secret", false);
    get secret() {
        return this._secret;
    }
    putSecret(value) {
        this._secret.internalValue = value;
    }
    resetSecret() {
        this._secret.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretInput() {
        return this._secret.internalValue;
    }
    // service_account_token - computed: false, optional: true, required: false
    _serviceAccountToken = new DeploymentSpecTemplateSpecVolumeProjectedSourcesServiceAccountTokenOutputReference(this, "service_account_token");
    get serviceAccountToken() {
        return this._serviceAccountToken;
    }
    putServiceAccountToken(value) {
        this._serviceAccountToken.internalValue = value;
    }
    resetServiceAccountToken() {
        this._serviceAccountToken.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get serviceAccountTokenInput() {
        return this._serviceAccountToken.internalValue;
    }
}
export class DeploymentSpecTemplateSpecVolumeProjectedSourcesList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeProjectedSourcesOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeProjectedToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        default_mode: cdktf.stringToTerraform(struct.defaultMode),
        sources: cdktf.listMapper(deploymentSpecTemplateSpecVolumeProjectedSourcesToTerraform, true)(struct.sources),
    };
}
export function deploymentSpecTemplateSpecVolumeProjectedToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        default_mode: {
            value: cdktf.stringToHclTerraform(struct.defaultMode),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        sources: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeProjectedSourcesToHclTerraform, true)(struct.sources),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedSourcesList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeProjectedOutputReference extends cdktf.ComplexObject {
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
        if (this._defaultMode !== undefined) {
            hasAnyValues = true;
            internalValueResult.defaultMode = this._defaultMode;
        }
        if (this._sources?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.sources = this._sources?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._defaultMode = undefined;
            this._sources.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._defaultMode = value.defaultMode;
            this._sources.internalValue = value.sources;
        }
    }
    // default_mode - computed: false, optional: true, required: false
    _defaultMode;
    get defaultMode() {
        return this.getStringAttribute('default_mode');
    }
    set defaultMode(value) {
        this._defaultMode = value;
    }
    resetDefaultMode() {
        this._defaultMode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get defaultModeInput() {
        return this._defaultMode;
    }
    // sources - computed: false, optional: false, required: true
    _sources = new DeploymentSpecTemplateSpecVolumeProjectedSourcesList(this, "sources", false);
    get sources() {
        return this._sources;
    }
    putSources(value) {
        this._sources.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get sourcesInput() {
        return this._sources.internalValue;
    }
}
export class DeploymentSpecTemplateSpecVolumeProjectedList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeProjectedOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeQuobyteToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        group: cdktf.stringToTerraform(struct.group),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        registry: cdktf.stringToTerraform(struct.registry),
        user: cdktf.stringToTerraform(struct.user),
        volume: cdktf.stringToTerraform(struct.volume),
    };
}
export function deploymentSpecTemplateSpecVolumeQuobyteToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        group: {
            value: cdktf.stringToHclTerraform(struct.group),
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
        registry: {
            value: cdktf.stringToHclTerraform(struct.registry),
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
        volume: {
            value: cdktf.stringToHclTerraform(struct.volume),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeQuobyteOutputReference extends cdktf.ComplexObject {
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
        if (this._group !== undefined) {
            hasAnyValues = true;
            internalValueResult.group = this._group;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
        }
        if (this._registry !== undefined) {
            hasAnyValues = true;
            internalValueResult.registry = this._registry;
        }
        if (this._user !== undefined) {
            hasAnyValues = true;
            internalValueResult.user = this._user;
        }
        if (this._volume !== undefined) {
            hasAnyValues = true;
            internalValueResult.volume = this._volume;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._group = undefined;
            this._readOnly = undefined;
            this._registry = undefined;
            this._user = undefined;
            this._volume = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._group = value.group;
            this._readOnly = value.readOnly;
            this._registry = value.registry;
            this._user = value.user;
            this._volume = value.volume;
        }
    }
    // group - computed: false, optional: true, required: false
    _group;
    get group() {
        return this.getStringAttribute('group');
    }
    set group(value) {
        this._group = value;
    }
    resetGroup() {
        this._group = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get groupInput() {
        return this._group;
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
    // registry - computed: false, optional: false, required: true
    _registry;
    get registry() {
        return this.getStringAttribute('registry');
    }
    set registry(value) {
        this._registry = value;
    }
    // Temporarily expose input value. Use with caution.
    get registryInput() {
        return this._registry;
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
    // volume - computed: false, optional: false, required: true
    _volume;
    get volume() {
        return this.getStringAttribute('volume');
    }
    set volume(value) {
        this._volume = value;
    }
    // Temporarily expose input value. Use with caution.
    get volumeInput() {
        return this._volume;
    }
}
export function deploymentSpecTemplateSpecVolumeRbdSecretRefToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        namespace: cdktf.stringToTerraform(struct.namespace),
    };
}
export function deploymentSpecTemplateSpecVolumeRbdSecretRefToHclTerraform(struct) {
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
export class DeploymentSpecTemplateSpecVolumeRbdSecretRefOutputReference extends cdktf.ComplexObject {
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
        if (this._namespace !== undefined) {
            hasAnyValues = true;
            internalValueResult.namespace = this._namespace;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._name = undefined;
            this._namespace = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._name = value.name;
            this._namespace = value.namespace;
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
    // namespace - computed: true, optional: true, required: false
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
}
export function deploymentSpecTemplateSpecVolumeRbdToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        ceph_monitors: cdktf.listMapper(cdktf.stringToTerraform, false)(struct.cephMonitors),
        fs_type: cdktf.stringToTerraform(struct.fsType),
        keyring: cdktf.stringToTerraform(struct.keyring),
        rados_user: cdktf.stringToTerraform(struct.radosUser),
        rbd_image: cdktf.stringToTerraform(struct.rbdImage),
        rbd_pool: cdktf.stringToTerraform(struct.rbdPool),
        read_only: cdktf.booleanToTerraform(struct.readOnly),
        secret_ref: deploymentSpecTemplateSpecVolumeRbdSecretRefToTerraform(struct.secretRef),
    };
}
export function deploymentSpecTemplateSpecVolumeRbdToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        ceph_monitors: {
            value: cdktf.listMapperHcl(cdktf.stringToHclTerraform, false)(struct.cephMonitors),
            isBlock: false,
            type: "set",
            storageClassType: "stringList",
        },
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        keyring: {
            value: cdktf.stringToHclTerraform(struct.keyring),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        rados_user: {
            value: cdktf.stringToHclTerraform(struct.radosUser),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        rbd_image: {
            value: cdktf.stringToHclTerraform(struct.rbdImage),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        rbd_pool: {
            value: cdktf.stringToHclTerraform(struct.rbdPool),
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
        secret_ref: {
            value: deploymentSpecTemplateSpecVolumeRbdSecretRefToHclTerraform(struct.secretRef),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeRbdSecretRefList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeRbdOutputReference extends cdktf.ComplexObject {
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
        if (this._cephMonitors !== undefined) {
            hasAnyValues = true;
            internalValueResult.cephMonitors = this._cephMonitors;
        }
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._keyring !== undefined) {
            hasAnyValues = true;
            internalValueResult.keyring = this._keyring;
        }
        if (this._radosUser !== undefined) {
            hasAnyValues = true;
            internalValueResult.radosUser = this._radosUser;
        }
        if (this._rbdImage !== undefined) {
            hasAnyValues = true;
            internalValueResult.rbdImage = this._rbdImage;
        }
        if (this._rbdPool !== undefined) {
            hasAnyValues = true;
            internalValueResult.rbdPool = this._rbdPool;
        }
        if (this._readOnly !== undefined) {
            hasAnyValues = true;
            internalValueResult.readOnly = this._readOnly;
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
            this._cephMonitors = undefined;
            this._fsType = undefined;
            this._keyring = undefined;
            this._radosUser = undefined;
            this._rbdImage = undefined;
            this._rbdPool = undefined;
            this._readOnly = undefined;
            this._secretRef.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._cephMonitors = value.cephMonitors;
            this._fsType = value.fsType;
            this._keyring = value.keyring;
            this._radosUser = value.radosUser;
            this._rbdImage = value.rbdImage;
            this._rbdPool = value.rbdPool;
            this._readOnly = value.readOnly;
            this._secretRef.internalValue = value.secretRef;
        }
    }
    // ceph_monitors - computed: false, optional: false, required: true
    _cephMonitors;
    get cephMonitors() {
        return cdktf.Fn.tolist(this.getListAttribute('ceph_monitors'));
    }
    set cephMonitors(value) {
        this._cephMonitors = value;
    }
    // Temporarily expose input value. Use with caution.
    get cephMonitorsInput() {
        return this._cephMonitors;
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // keyring - computed: true, optional: true, required: false
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
    // rados_user - computed: false, optional: true, required: false
    _radosUser;
    get radosUser() {
        return this.getStringAttribute('rados_user');
    }
    set radosUser(value) {
        this._radosUser = value;
    }
    resetRadosUser() {
        this._radosUser = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get radosUserInput() {
        return this._radosUser;
    }
    // rbd_image - computed: false, optional: false, required: true
    _rbdImage;
    get rbdImage() {
        return this.getStringAttribute('rbd_image');
    }
    set rbdImage(value) {
        this._rbdImage = value;
    }
    // Temporarily expose input value. Use with caution.
    get rbdImageInput() {
        return this._rbdImage;
    }
    // rbd_pool - computed: false, optional: true, required: false
    _rbdPool;
    get rbdPool() {
        return this.getStringAttribute('rbd_pool');
    }
    set rbdPool(value) {
        this._rbdPool = value;
    }
    resetRbdPool() {
        this._rbdPool = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get rbdPoolInput() {
        return this._rbdPool;
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
    // secret_ref - computed: false, optional: true, required: false
    _secretRef = new DeploymentSpecTemplateSpecVolumeRbdSecretRefOutputReference(this, "secret_ref");
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
export function deploymentSpecTemplateSpecVolumeSecretItemsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        key: cdktf.stringToTerraform(struct.key),
        mode: cdktf.stringToTerraform(struct.mode),
        path: cdktf.stringToTerraform(struct.path),
    };
}
export function deploymentSpecTemplateSpecVolumeSecretItemsToHclTerraform(struct) {
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
        mode: {
            value: cdktf.stringToHclTerraform(struct.mode),
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
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeSecretItemsOutputReference extends cdktf.ComplexObject {
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
        if (this._mode !== undefined) {
            hasAnyValues = true;
            internalValueResult.mode = this._mode;
        }
        if (this._path !== undefined) {
            hasAnyValues = true;
            internalValueResult.path = this._path;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._key = undefined;
            this._mode = undefined;
            this._path = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._key = value.key;
            this._mode = value.mode;
            this._path = value.path;
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
    // mode - computed: false, optional: true, required: false
    _mode;
    get mode() {
        return this.getStringAttribute('mode');
    }
    set mode(value) {
        this._mode = value;
    }
    resetMode() {
        this._mode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get modeInput() {
        return this._mode;
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
}
export class DeploymentSpecTemplateSpecVolumeSecretItemsList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeSecretItemsOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecVolumeSecretToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        default_mode: cdktf.stringToTerraform(struct.defaultMode),
        optional: cdktf.booleanToTerraform(struct.optional),
        secret_name: cdktf.stringToTerraform(struct.secretName),
        items: cdktf.listMapper(deploymentSpecTemplateSpecVolumeSecretItemsToTerraform, true)(struct.items),
    };
}
export function deploymentSpecTemplateSpecVolumeSecretToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        default_mode: {
            value: cdktf.stringToHclTerraform(struct.defaultMode),
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
        secret_name: {
            value: cdktf.stringToHclTerraform(struct.secretName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        items: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeSecretItemsToHclTerraform, true)(struct.items),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeSecretItemsList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeSecretOutputReference extends cdktf.ComplexObject {
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
        if (this._defaultMode !== undefined) {
            hasAnyValues = true;
            internalValueResult.defaultMode = this._defaultMode;
        }
        if (this._optional !== undefined) {
            hasAnyValues = true;
            internalValueResult.optional = this._optional;
        }
        if (this._secretName !== undefined) {
            hasAnyValues = true;
            internalValueResult.secretName = this._secretName;
        }
        if (this._items?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.items = this._items?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._defaultMode = undefined;
            this._optional = undefined;
            this._secretName = undefined;
            this._items.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._defaultMode = value.defaultMode;
            this._optional = value.optional;
            this._secretName = value.secretName;
            this._items.internalValue = value.items;
        }
    }
    // default_mode - computed: false, optional: true, required: false
    _defaultMode;
    get defaultMode() {
        return this.getStringAttribute('default_mode');
    }
    set defaultMode(value) {
        this._defaultMode = value;
    }
    resetDefaultMode() {
        this._defaultMode = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get defaultModeInput() {
        return this._defaultMode;
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
    // secret_name - computed: false, optional: true, required: false
    _secretName;
    get secretName() {
        return this.getStringAttribute('secret_name');
    }
    set secretName(value) {
        this._secretName = value;
    }
    resetSecretName() {
        this._secretName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretNameInput() {
        return this._secretName;
    }
    // items - computed: false, optional: true, required: false
    _items = new DeploymentSpecTemplateSpecVolumeSecretItemsList(this, "items", false);
    get items() {
        return this._items;
    }
    putItems(value) {
        this._items.internalValue = value;
    }
    resetItems() {
        this._items.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get itemsInput() {
        return this._items.internalValue;
    }
}
export function deploymentSpecTemplateSpecVolumeVsphereVolumeToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        fs_type: cdktf.stringToTerraform(struct.fsType),
        volume_path: cdktf.stringToTerraform(struct.volumePath),
    };
}
export function deploymentSpecTemplateSpecVolumeVsphereVolumeToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        fs_type: {
            value: cdktf.stringToHclTerraform(struct.fsType),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        volume_path: {
            value: cdktf.stringToHclTerraform(struct.volumePath),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeVsphereVolumeOutputReference extends cdktf.ComplexObject {
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
        if (this._fsType !== undefined) {
            hasAnyValues = true;
            internalValueResult.fsType = this._fsType;
        }
        if (this._volumePath !== undefined) {
            hasAnyValues = true;
            internalValueResult.volumePath = this._volumePath;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._fsType = undefined;
            this._volumePath = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._fsType = value.fsType;
            this._volumePath = value.volumePath;
        }
    }
    // fs_type - computed: false, optional: true, required: false
    _fsType;
    get fsType() {
        return this.getStringAttribute('fs_type');
    }
    set fsType(value) {
        this._fsType = value;
    }
    resetFsType() {
        this._fsType = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fsTypeInput() {
        return this._fsType;
    }
    // volume_path - computed: false, optional: false, required: true
    _volumePath;
    get volumePath() {
        return this.getStringAttribute('volume_path');
    }
    set volumePath(value) {
        this._volumePath = value;
    }
    // Temporarily expose input value. Use with caution.
    get volumePathInput() {
        return this._volumePath;
    }
}
export function deploymentSpecTemplateSpecVolumeToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        name: cdktf.stringToTerraform(struct.name),
        aws_elastic_block_store: deploymentSpecTemplateSpecVolumeAwsElasticBlockStoreToTerraform(struct.awsElasticBlockStore),
        azure_disk: deploymentSpecTemplateSpecVolumeAzureDiskToTerraform(struct.azureDisk),
        azure_file: deploymentSpecTemplateSpecVolumeAzureFileToTerraform(struct.azureFile),
        ceph_fs: deploymentSpecTemplateSpecVolumeCephFsToTerraform(struct.cephFs),
        cinder: deploymentSpecTemplateSpecVolumeCinderToTerraform(struct.cinder),
        config_map: deploymentSpecTemplateSpecVolumeConfigMapToTerraform(struct.configMap),
        csi: deploymentSpecTemplateSpecVolumeCsiToTerraform(struct.csi),
        downward_api: deploymentSpecTemplateSpecVolumeDownwardApiToTerraform(struct.downwardApi),
        empty_dir: deploymentSpecTemplateSpecVolumeEmptyDirToTerraform(struct.emptyDir),
        ephemeral: deploymentSpecTemplateSpecVolumeEphemeralToTerraform(struct.ephemeral),
        fc: deploymentSpecTemplateSpecVolumeFcToTerraform(struct.fc),
        flex_volume: deploymentSpecTemplateSpecVolumeFlexVolumeToTerraform(struct.flexVolume),
        flocker: deploymentSpecTemplateSpecVolumeFlockerToTerraform(struct.flocker),
        gce_persistent_disk: deploymentSpecTemplateSpecVolumeGcePersistentDiskToTerraform(struct.gcePersistentDisk),
        git_repo: deploymentSpecTemplateSpecVolumeGitRepoToTerraform(struct.gitRepo),
        glusterfs: deploymentSpecTemplateSpecVolumeGlusterfsToTerraform(struct.glusterfs),
        host_path: deploymentSpecTemplateSpecVolumeHostPathToTerraform(struct.hostPath),
        iscsi: deploymentSpecTemplateSpecVolumeIscsiToTerraform(struct.iscsi),
        local: deploymentSpecTemplateSpecVolumeLocalToTerraform(struct.local),
        nfs: deploymentSpecTemplateSpecVolumeNfsToTerraform(struct.nfs),
        persistent_volume_claim: deploymentSpecTemplateSpecVolumePersistentVolumeClaimToTerraform(struct.persistentVolumeClaim),
        photon_persistent_disk: deploymentSpecTemplateSpecVolumePhotonPersistentDiskToTerraform(struct.photonPersistentDisk),
        projected: cdktf.listMapper(deploymentSpecTemplateSpecVolumeProjectedToTerraform, true)(struct.projected),
        quobyte: deploymentSpecTemplateSpecVolumeQuobyteToTerraform(struct.quobyte),
        rbd: deploymentSpecTemplateSpecVolumeRbdToTerraform(struct.rbd),
        secret: deploymentSpecTemplateSpecVolumeSecretToTerraform(struct.secret),
        vsphere_volume: deploymentSpecTemplateSpecVolumeVsphereVolumeToTerraform(struct.vsphereVolume),
    };
}
export function deploymentSpecTemplateSpecVolumeToHclTerraform(struct) {
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
        aws_elastic_block_store: {
            value: deploymentSpecTemplateSpecVolumeAwsElasticBlockStoreToHclTerraform(struct.awsElasticBlockStore),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeAwsElasticBlockStoreList",
        },
        azure_disk: {
            value: deploymentSpecTemplateSpecVolumeAzureDiskToHclTerraform(struct.azureDisk),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeAzureDiskList",
        },
        azure_file: {
            value: deploymentSpecTemplateSpecVolumeAzureFileToHclTerraform(struct.azureFile),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeAzureFileList",
        },
        ceph_fs: {
            value: deploymentSpecTemplateSpecVolumeCephFsToHclTerraform(struct.cephFs),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeCephFsList",
        },
        cinder: {
            value: deploymentSpecTemplateSpecVolumeCinderToHclTerraform(struct.cinder),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeCinderList",
        },
        config_map: {
            value: deploymentSpecTemplateSpecVolumeConfigMapToHclTerraform(struct.configMap),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeConfigMapList",
        },
        csi: {
            value: deploymentSpecTemplateSpecVolumeCsiToHclTerraform(struct.csi),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeCsiList",
        },
        downward_api: {
            value: deploymentSpecTemplateSpecVolumeDownwardApiToHclTerraform(struct.downwardApi),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeDownwardApiList",
        },
        empty_dir: {
            value: deploymentSpecTemplateSpecVolumeEmptyDirToHclTerraform(struct.emptyDir),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEmptyDirList",
        },
        ephemeral: {
            value: deploymentSpecTemplateSpecVolumeEphemeralToHclTerraform(struct.ephemeral),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeEphemeralList",
        },
        fc: {
            value: deploymentSpecTemplateSpecVolumeFcToHclTerraform(struct.fc),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeFcList",
        },
        flex_volume: {
            value: deploymentSpecTemplateSpecVolumeFlexVolumeToHclTerraform(struct.flexVolume),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeFlexVolumeList",
        },
        flocker: {
            value: deploymentSpecTemplateSpecVolumeFlockerToHclTerraform(struct.flocker),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeFlockerList",
        },
        gce_persistent_disk: {
            value: deploymentSpecTemplateSpecVolumeGcePersistentDiskToHclTerraform(struct.gcePersistentDisk),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeGcePersistentDiskList",
        },
        git_repo: {
            value: deploymentSpecTemplateSpecVolumeGitRepoToHclTerraform(struct.gitRepo),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeGitRepoList",
        },
        glusterfs: {
            value: deploymentSpecTemplateSpecVolumeGlusterfsToHclTerraform(struct.glusterfs),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeGlusterfsList",
        },
        host_path: {
            value: deploymentSpecTemplateSpecVolumeHostPathToHclTerraform(struct.hostPath),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeHostPathList",
        },
        iscsi: {
            value: deploymentSpecTemplateSpecVolumeIscsiToHclTerraform(struct.iscsi),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeIscsiList",
        },
        local: {
            value: deploymentSpecTemplateSpecVolumeLocalToHclTerraform(struct.local),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeLocalList",
        },
        nfs: {
            value: deploymentSpecTemplateSpecVolumeNfsToHclTerraform(struct.nfs),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeNfsList",
        },
        persistent_volume_claim: {
            value: deploymentSpecTemplateSpecVolumePersistentVolumeClaimToHclTerraform(struct.persistentVolumeClaim),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumePersistentVolumeClaimList",
        },
        photon_persistent_disk: {
            value: deploymentSpecTemplateSpecVolumePhotonPersistentDiskToHclTerraform(struct.photonPersistentDisk),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumePhotonPersistentDiskList",
        },
        projected: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeProjectedToHclTerraform, true)(struct.projected),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeProjectedList",
        },
        quobyte: {
            value: deploymentSpecTemplateSpecVolumeQuobyteToHclTerraform(struct.quobyte),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeQuobyteList",
        },
        rbd: {
            value: deploymentSpecTemplateSpecVolumeRbdToHclTerraform(struct.rbd),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeRbdList",
        },
        secret: {
            value: deploymentSpecTemplateSpecVolumeSecretToHclTerraform(struct.secret),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeSecretList",
        },
        vsphere_volume: {
            value: deploymentSpecTemplateSpecVolumeVsphereVolumeToHclTerraform(struct.vsphereVolume),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeVsphereVolumeList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecVolumeOutputReference extends cdktf.ComplexObject {
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
        if (this._awsElasticBlockStore?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.awsElasticBlockStore = this._awsElasticBlockStore?.internalValue;
        }
        if (this._azureDisk?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.azureDisk = this._azureDisk?.internalValue;
        }
        if (this._azureFile?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.azureFile = this._azureFile?.internalValue;
        }
        if (this._cephFs?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.cephFs = this._cephFs?.internalValue;
        }
        if (this._cinder?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.cinder = this._cinder?.internalValue;
        }
        if (this._configMap?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.configMap = this._configMap?.internalValue;
        }
        if (this._csi?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.csi = this._csi?.internalValue;
        }
        if (this._downwardApi?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.downwardApi = this._downwardApi?.internalValue;
        }
        if (this._emptyDir?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.emptyDir = this._emptyDir?.internalValue;
        }
        if (this._ephemeral?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.ephemeral = this._ephemeral?.internalValue;
        }
        if (this._fc?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.fc = this._fc?.internalValue;
        }
        if (this._flexVolume?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.flexVolume = this._flexVolume?.internalValue;
        }
        if (this._flocker?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.flocker = this._flocker?.internalValue;
        }
        if (this._gcePersistentDisk?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.gcePersistentDisk = this._gcePersistentDisk?.internalValue;
        }
        if (this._gitRepo?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.gitRepo = this._gitRepo?.internalValue;
        }
        if (this._glusterfs?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.glusterfs = this._glusterfs?.internalValue;
        }
        if (this._hostPath?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostPath = this._hostPath?.internalValue;
        }
        if (this._iscsi?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.iscsi = this._iscsi?.internalValue;
        }
        if (this._local?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.local = this._local?.internalValue;
        }
        if (this._nfs?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.nfs = this._nfs?.internalValue;
        }
        if (this._persistentVolumeClaim?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.persistentVolumeClaim = this._persistentVolumeClaim?.internalValue;
        }
        if (this._photonPersistentDisk?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.photonPersistentDisk = this._photonPersistentDisk?.internalValue;
        }
        if (this._projected?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.projected = this._projected?.internalValue;
        }
        if (this._quobyte?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.quobyte = this._quobyte?.internalValue;
        }
        if (this._rbd?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.rbd = this._rbd?.internalValue;
        }
        if (this._secret?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.secret = this._secret?.internalValue;
        }
        if (this._vsphereVolume?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.vsphereVolume = this._vsphereVolume?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._name = undefined;
            this._awsElasticBlockStore.internalValue = undefined;
            this._azureDisk.internalValue = undefined;
            this._azureFile.internalValue = undefined;
            this._cephFs.internalValue = undefined;
            this._cinder.internalValue = undefined;
            this._configMap.internalValue = undefined;
            this._csi.internalValue = undefined;
            this._downwardApi.internalValue = undefined;
            this._emptyDir.internalValue = undefined;
            this._ephemeral.internalValue = undefined;
            this._fc.internalValue = undefined;
            this._flexVolume.internalValue = undefined;
            this._flocker.internalValue = undefined;
            this._gcePersistentDisk.internalValue = undefined;
            this._gitRepo.internalValue = undefined;
            this._glusterfs.internalValue = undefined;
            this._hostPath.internalValue = undefined;
            this._iscsi.internalValue = undefined;
            this._local.internalValue = undefined;
            this._nfs.internalValue = undefined;
            this._persistentVolumeClaim.internalValue = undefined;
            this._photonPersistentDisk.internalValue = undefined;
            this._projected.internalValue = undefined;
            this._quobyte.internalValue = undefined;
            this._rbd.internalValue = undefined;
            this._secret.internalValue = undefined;
            this._vsphereVolume.internalValue = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._name = value.name;
            this._awsElasticBlockStore.internalValue = value.awsElasticBlockStore;
            this._azureDisk.internalValue = value.azureDisk;
            this._azureFile.internalValue = value.azureFile;
            this._cephFs.internalValue = value.cephFs;
            this._cinder.internalValue = value.cinder;
            this._configMap.internalValue = value.configMap;
            this._csi.internalValue = value.csi;
            this._downwardApi.internalValue = value.downwardApi;
            this._emptyDir.internalValue = value.emptyDir;
            this._ephemeral.internalValue = value.ephemeral;
            this._fc.internalValue = value.fc;
            this._flexVolume.internalValue = value.flexVolume;
            this._flocker.internalValue = value.flocker;
            this._gcePersistentDisk.internalValue = value.gcePersistentDisk;
            this._gitRepo.internalValue = value.gitRepo;
            this._glusterfs.internalValue = value.glusterfs;
            this._hostPath.internalValue = value.hostPath;
            this._iscsi.internalValue = value.iscsi;
            this._local.internalValue = value.local;
            this._nfs.internalValue = value.nfs;
            this._persistentVolumeClaim.internalValue = value.persistentVolumeClaim;
            this._photonPersistentDisk.internalValue = value.photonPersistentDisk;
            this._projected.internalValue = value.projected;
            this._quobyte.internalValue = value.quobyte;
            this._rbd.internalValue = value.rbd;
            this._secret.internalValue = value.secret;
            this._vsphereVolume.internalValue = value.vsphereVolume;
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
    // aws_elastic_block_store - computed: false, optional: true, required: false
    _awsElasticBlockStore = new DeploymentSpecTemplateSpecVolumeAwsElasticBlockStoreOutputReference(this, "aws_elastic_block_store");
    get awsElasticBlockStore() {
        return this._awsElasticBlockStore;
    }
    putAwsElasticBlockStore(value) {
        this._awsElasticBlockStore.internalValue = value;
    }
    resetAwsElasticBlockStore() {
        this._awsElasticBlockStore.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get awsElasticBlockStoreInput() {
        return this._awsElasticBlockStore.internalValue;
    }
    // azure_disk - computed: false, optional: true, required: false
    _azureDisk = new DeploymentSpecTemplateSpecVolumeAzureDiskOutputReference(this, "azure_disk");
    get azureDisk() {
        return this._azureDisk;
    }
    putAzureDisk(value) {
        this._azureDisk.internalValue = value;
    }
    resetAzureDisk() {
        this._azureDisk.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get azureDiskInput() {
        return this._azureDisk.internalValue;
    }
    // azure_file - computed: false, optional: true, required: false
    _azureFile = new DeploymentSpecTemplateSpecVolumeAzureFileOutputReference(this, "azure_file");
    get azureFile() {
        return this._azureFile;
    }
    putAzureFile(value) {
        this._azureFile.internalValue = value;
    }
    resetAzureFile() {
        this._azureFile.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get azureFileInput() {
        return this._azureFile.internalValue;
    }
    // ceph_fs - computed: false, optional: true, required: false
    _cephFs = new DeploymentSpecTemplateSpecVolumeCephFsOutputReference(this, "ceph_fs");
    get cephFs() {
        return this._cephFs;
    }
    putCephFs(value) {
        this._cephFs.internalValue = value;
    }
    resetCephFs() {
        this._cephFs.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get cephFsInput() {
        return this._cephFs.internalValue;
    }
    // cinder - computed: false, optional: true, required: false
    _cinder = new DeploymentSpecTemplateSpecVolumeCinderOutputReference(this, "cinder");
    get cinder() {
        return this._cinder;
    }
    putCinder(value) {
        this._cinder.internalValue = value;
    }
    resetCinder() {
        this._cinder.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get cinderInput() {
        return this._cinder.internalValue;
    }
    // config_map - computed: false, optional: true, required: false
    _configMap = new DeploymentSpecTemplateSpecVolumeConfigMapOutputReference(this, "config_map");
    get configMap() {
        return this._configMap;
    }
    putConfigMap(value) {
        this._configMap.internalValue = value;
    }
    resetConfigMap() {
        this._configMap.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get configMapInput() {
        return this._configMap.internalValue;
    }
    // csi - computed: false, optional: true, required: false
    _csi = new DeploymentSpecTemplateSpecVolumeCsiOutputReference(this, "csi");
    get csi() {
        return this._csi;
    }
    putCsi(value) {
        this._csi.internalValue = value;
    }
    resetCsi() {
        this._csi.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get csiInput() {
        return this._csi.internalValue;
    }
    // downward_api - computed: false, optional: true, required: false
    _downwardApi = new DeploymentSpecTemplateSpecVolumeDownwardApiOutputReference(this, "downward_api");
    get downwardApi() {
        return this._downwardApi;
    }
    putDownwardApi(value) {
        this._downwardApi.internalValue = value;
    }
    resetDownwardApi() {
        this._downwardApi.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get downwardApiInput() {
        return this._downwardApi.internalValue;
    }
    // empty_dir - computed: false, optional: true, required: false
    _emptyDir = new DeploymentSpecTemplateSpecVolumeEmptyDirOutputReference(this, "empty_dir");
    get emptyDir() {
        return this._emptyDir;
    }
    putEmptyDir(value) {
        this._emptyDir.internalValue = value;
    }
    resetEmptyDir() {
        this._emptyDir.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get emptyDirInput() {
        return this._emptyDir.internalValue;
    }
    // ephemeral - computed: false, optional: true, required: false
    _ephemeral = new DeploymentSpecTemplateSpecVolumeEphemeralOutputReference(this, "ephemeral");
    get ephemeral() {
        return this._ephemeral;
    }
    putEphemeral(value) {
        this._ephemeral.internalValue = value;
    }
    resetEphemeral() {
        this._ephemeral.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get ephemeralInput() {
        return this._ephemeral.internalValue;
    }
    // fc - computed: false, optional: true, required: false
    _fc = new DeploymentSpecTemplateSpecVolumeFcOutputReference(this, "fc");
    get fc() {
        return this._fc;
    }
    putFc(value) {
        this._fc.internalValue = value;
    }
    resetFc() {
        this._fc.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get fcInput() {
        return this._fc.internalValue;
    }
    // flex_volume - computed: false, optional: true, required: false
    _flexVolume = new DeploymentSpecTemplateSpecVolumeFlexVolumeOutputReference(this, "flex_volume");
    get flexVolume() {
        return this._flexVolume;
    }
    putFlexVolume(value) {
        this._flexVolume.internalValue = value;
    }
    resetFlexVolume() {
        this._flexVolume.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get flexVolumeInput() {
        return this._flexVolume.internalValue;
    }
    // flocker - computed: false, optional: true, required: false
    _flocker = new DeploymentSpecTemplateSpecVolumeFlockerOutputReference(this, "flocker");
    get flocker() {
        return this._flocker;
    }
    putFlocker(value) {
        this._flocker.internalValue = value;
    }
    resetFlocker() {
        this._flocker.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get flockerInput() {
        return this._flocker.internalValue;
    }
    // gce_persistent_disk - computed: false, optional: true, required: false
    _gcePersistentDisk = new DeploymentSpecTemplateSpecVolumeGcePersistentDiskOutputReference(this, "gce_persistent_disk");
    get gcePersistentDisk() {
        return this._gcePersistentDisk;
    }
    putGcePersistentDisk(value) {
        this._gcePersistentDisk.internalValue = value;
    }
    resetGcePersistentDisk() {
        this._gcePersistentDisk.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get gcePersistentDiskInput() {
        return this._gcePersistentDisk.internalValue;
    }
    // git_repo - computed: false, optional: true, required: false
    _gitRepo = new DeploymentSpecTemplateSpecVolumeGitRepoOutputReference(this, "git_repo");
    get gitRepo() {
        return this._gitRepo;
    }
    putGitRepo(value) {
        this._gitRepo.internalValue = value;
    }
    resetGitRepo() {
        this._gitRepo.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get gitRepoInput() {
        return this._gitRepo.internalValue;
    }
    // glusterfs - computed: false, optional: true, required: false
    _glusterfs = new DeploymentSpecTemplateSpecVolumeGlusterfsOutputReference(this, "glusterfs");
    get glusterfs() {
        return this._glusterfs;
    }
    putGlusterfs(value) {
        this._glusterfs.internalValue = value;
    }
    resetGlusterfs() {
        this._glusterfs.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get glusterfsInput() {
        return this._glusterfs.internalValue;
    }
    // host_path - computed: false, optional: true, required: false
    _hostPath = new DeploymentSpecTemplateSpecVolumeHostPathOutputReference(this, "host_path");
    get hostPath() {
        return this._hostPath;
    }
    putHostPath(value) {
        this._hostPath.internalValue = value;
    }
    resetHostPath() {
        this._hostPath.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostPathInput() {
        return this._hostPath.internalValue;
    }
    // iscsi - computed: false, optional: true, required: false
    _iscsi = new DeploymentSpecTemplateSpecVolumeIscsiOutputReference(this, "iscsi");
    get iscsi() {
        return this._iscsi;
    }
    putIscsi(value) {
        this._iscsi.internalValue = value;
    }
    resetIscsi() {
        this._iscsi.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get iscsiInput() {
        return this._iscsi.internalValue;
    }
    // local - computed: false, optional: true, required: false
    _local = new DeploymentSpecTemplateSpecVolumeLocalOutputReference(this, "local");
    get local() {
        return this._local;
    }
    putLocal(value) {
        this._local.internalValue = value;
    }
    resetLocal() {
        this._local.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get localInput() {
        return this._local.internalValue;
    }
    // nfs - computed: false, optional: true, required: false
    _nfs = new DeploymentSpecTemplateSpecVolumeNfsOutputReference(this, "nfs");
    get nfs() {
        return this._nfs;
    }
    putNfs(value) {
        this._nfs.internalValue = value;
    }
    resetNfs() {
        this._nfs.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nfsInput() {
        return this._nfs.internalValue;
    }
    // persistent_volume_claim - computed: false, optional: true, required: false
    _persistentVolumeClaim = new DeploymentSpecTemplateSpecVolumePersistentVolumeClaimOutputReference(this, "persistent_volume_claim");
    get persistentVolumeClaim() {
        return this._persistentVolumeClaim;
    }
    putPersistentVolumeClaim(value) {
        this._persistentVolumeClaim.internalValue = value;
    }
    resetPersistentVolumeClaim() {
        this._persistentVolumeClaim.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get persistentVolumeClaimInput() {
        return this._persistentVolumeClaim.internalValue;
    }
    // photon_persistent_disk - computed: false, optional: true, required: false
    _photonPersistentDisk = new DeploymentSpecTemplateSpecVolumePhotonPersistentDiskOutputReference(this, "photon_persistent_disk");
    get photonPersistentDisk() {
        return this._photonPersistentDisk;
    }
    putPhotonPersistentDisk(value) {
        this._photonPersistentDisk.internalValue = value;
    }
    resetPhotonPersistentDisk() {
        this._photonPersistentDisk.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get photonPersistentDiskInput() {
        return this._photonPersistentDisk.internalValue;
    }
    // projected - computed: false, optional: true, required: false
    _projected = new DeploymentSpecTemplateSpecVolumeProjectedList(this, "projected", false);
    get projected() {
        return this._projected;
    }
    putProjected(value) {
        this._projected.internalValue = value;
    }
    resetProjected() {
        this._projected.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get projectedInput() {
        return this._projected.internalValue;
    }
    // quobyte - computed: false, optional: true, required: false
    _quobyte = new DeploymentSpecTemplateSpecVolumeQuobyteOutputReference(this, "quobyte");
    get quobyte() {
        return this._quobyte;
    }
    putQuobyte(value) {
        this._quobyte.internalValue = value;
    }
    resetQuobyte() {
        this._quobyte.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get quobyteInput() {
        return this._quobyte.internalValue;
    }
    // rbd - computed: false, optional: true, required: false
    _rbd = new DeploymentSpecTemplateSpecVolumeRbdOutputReference(this, "rbd");
    get rbd() {
        return this._rbd;
    }
    putRbd(value) {
        this._rbd.internalValue = value;
    }
    resetRbd() {
        this._rbd.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get rbdInput() {
        return this._rbd.internalValue;
    }
    // secret - computed: false, optional: true, required: false
    _secret = new DeploymentSpecTemplateSpecVolumeSecretOutputReference(this, "secret");
    get secret() {
        return this._secret;
    }
    putSecret(value) {
        this._secret.internalValue = value;
    }
    resetSecret() {
        this._secret.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get secretInput() {
        return this._secret.internalValue;
    }
    // vsphere_volume - computed: false, optional: true, required: false
    _vsphereVolume = new DeploymentSpecTemplateSpecVolumeVsphereVolumeOutputReference(this, "vsphere_volume");
    get vsphereVolume() {
        return this._vsphereVolume;
    }
    putVsphereVolume(value) {
        this._vsphereVolume.internalValue = value;
    }
    resetVsphereVolume() {
        this._vsphereVolume.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get vsphereVolumeInput() {
        return this._vsphereVolume.internalValue;
    }
}
export class DeploymentSpecTemplateSpecVolumeList extends cdktf.ComplexList {
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
        return new DeploymentSpecTemplateSpecVolumeOutputReference(this.terraformResource, this.terraformAttribute, index, this.wrapsSet);
    }
}
export function deploymentSpecTemplateSpecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        active_deadline_seconds: cdktf.numberToTerraform(struct.activeDeadlineSeconds),
        automount_service_account_token: cdktf.booleanToTerraform(struct.automountServiceAccountToken),
        dns_policy: cdktf.stringToTerraform(struct.dnsPolicy),
        enable_service_links: cdktf.booleanToTerraform(struct.enableServiceLinks),
        host_ipc: cdktf.booleanToTerraform(struct.hostIpc),
        host_network: cdktf.booleanToTerraform(struct.hostNetwork),
        host_pid: cdktf.booleanToTerraform(struct.hostPid),
        hostname: cdktf.stringToTerraform(struct.hostname),
        node_name: cdktf.stringToTerraform(struct.nodeName),
        node_selector: cdktf.hashMapper(cdktf.stringToTerraform)(struct.nodeSelector),
        priority_class_name: cdktf.stringToTerraform(struct.priorityClassName),
        restart_policy: cdktf.stringToTerraform(struct.restartPolicy),
        runtime_class_name: cdktf.stringToTerraform(struct.runtimeClassName),
        scheduler_name: cdktf.stringToTerraform(struct.schedulerName),
        service_account_name: cdktf.stringToTerraform(struct.serviceAccountName),
        share_process_namespace: cdktf.booleanToTerraform(struct.shareProcessNamespace),
        subdomain: cdktf.stringToTerraform(struct.subdomain),
        termination_grace_period_seconds: cdktf.numberToTerraform(struct.terminationGracePeriodSeconds),
        affinity: deploymentSpecTemplateSpecAffinityToTerraform(struct.affinity),
        container: cdktf.listMapper(deploymentSpecTemplateSpecContainerToTerraform, true)(struct.container),
        dns_config: deploymentSpecTemplateSpecDnsConfigToTerraform(struct.dnsConfig),
        host_aliases: cdktf.listMapper(deploymentSpecTemplateSpecHostAliasesToTerraform, true)(struct.hostAliases),
        image_pull_secrets: cdktf.listMapper(deploymentSpecTemplateSpecImagePullSecretsToTerraform, true)(struct.imagePullSecrets),
        init_container: cdktf.listMapper(deploymentSpecTemplateSpecInitContainerToTerraform, true)(struct.initContainer),
        os: deploymentSpecTemplateSpecOsToTerraform(struct.os),
        readiness_gate: cdktf.listMapper(deploymentSpecTemplateSpecReadinessGateToTerraform, true)(struct.readinessGate),
        security_context: deploymentSpecTemplateSpecSecurityContextToTerraform(struct.securityContext),
        toleration: cdktf.listMapper(deploymentSpecTemplateSpecTolerationToTerraform, true)(struct.toleration),
        topology_spread_constraint: cdktf.listMapper(deploymentSpecTemplateSpecTopologySpreadConstraintToTerraform, true)(struct.topologySpreadConstraint),
        volume: cdktf.listMapper(deploymentSpecTemplateSpecVolumeToTerraform, true)(struct.volume),
    };
}
export function deploymentSpecTemplateSpecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        active_deadline_seconds: {
            value: cdktf.numberToHclTerraform(struct.activeDeadlineSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        automount_service_account_token: {
            value: cdktf.booleanToHclTerraform(struct.automountServiceAccountToken),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        dns_policy: {
            value: cdktf.stringToHclTerraform(struct.dnsPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        enable_service_links: {
            value: cdktf.booleanToHclTerraform(struct.enableServiceLinks),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        host_ipc: {
            value: cdktf.booleanToHclTerraform(struct.hostIpc),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        host_network: {
            value: cdktf.booleanToHclTerraform(struct.hostNetwork),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        host_pid: {
            value: cdktf.booleanToHclTerraform(struct.hostPid),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        hostname: {
            value: cdktf.stringToHclTerraform(struct.hostname),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        node_name: {
            value: cdktf.stringToHclTerraform(struct.nodeName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        node_selector: {
            value: cdktf.hashMapperHcl(cdktf.stringToHclTerraform)(struct.nodeSelector),
            isBlock: false,
            type: "map",
            storageClassType: "stringMap",
        },
        priority_class_name: {
            value: cdktf.stringToHclTerraform(struct.priorityClassName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        restart_policy: {
            value: cdktf.stringToHclTerraform(struct.restartPolicy),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        runtime_class_name: {
            value: cdktf.stringToHclTerraform(struct.runtimeClassName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        scheduler_name: {
            value: cdktf.stringToHclTerraform(struct.schedulerName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        service_account_name: {
            value: cdktf.stringToHclTerraform(struct.serviceAccountName),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        share_process_namespace: {
            value: cdktf.booleanToHclTerraform(struct.shareProcessNamespace),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        subdomain: {
            value: cdktf.stringToHclTerraform(struct.subdomain),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        termination_grace_period_seconds: {
            value: cdktf.numberToHclTerraform(struct.terminationGracePeriodSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        affinity: {
            value: deploymentSpecTemplateSpecAffinityToHclTerraform(struct.affinity),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecAffinityList",
        },
        container: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecContainerToHclTerraform, true)(struct.container),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecContainerList",
        },
        dns_config: {
            value: deploymentSpecTemplateSpecDnsConfigToHclTerraform(struct.dnsConfig),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecDnsConfigList",
        },
        host_aliases: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecHostAliasesToHclTerraform, true)(struct.hostAliases),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecHostAliasesList",
        },
        image_pull_secrets: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecImagePullSecretsToHclTerraform, true)(struct.imagePullSecrets),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecImagePullSecretsList",
        },
        init_container: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecInitContainerToHclTerraform, true)(struct.initContainer),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecInitContainerList",
        },
        os: {
            value: deploymentSpecTemplateSpecOsToHclTerraform(struct.os),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecOsList",
        },
        readiness_gate: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecReadinessGateToHclTerraform, true)(struct.readinessGate),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecReadinessGateList",
        },
        security_context: {
            value: deploymentSpecTemplateSpecSecurityContextToHclTerraform(struct.securityContext),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecSecurityContextList",
        },
        toleration: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecTolerationToHclTerraform, true)(struct.toleration),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecTolerationList",
        },
        topology_spread_constraint: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecTopologySpreadConstraintToHclTerraform, true)(struct.topologySpreadConstraint),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecTopologySpreadConstraintList",
        },
        volume: {
            value: cdktf.listMapperHcl(deploymentSpecTemplateSpecVolumeToHclTerraform, true)(struct.volume),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecVolumeList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateSpecOutputReference extends cdktf.ComplexObject {
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
        if (this._activeDeadlineSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.activeDeadlineSeconds = this._activeDeadlineSeconds;
        }
        if (this._automountServiceAccountToken !== undefined) {
            hasAnyValues = true;
            internalValueResult.automountServiceAccountToken = this._automountServiceAccountToken;
        }
        if (this._dnsPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.dnsPolicy = this._dnsPolicy;
        }
        if (this._enableServiceLinks !== undefined) {
            hasAnyValues = true;
            internalValueResult.enableServiceLinks = this._enableServiceLinks;
        }
        if (this._hostIpc !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostIpc = this._hostIpc;
        }
        if (this._hostNetwork !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostNetwork = this._hostNetwork;
        }
        if (this._hostPid !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostPid = this._hostPid;
        }
        if (this._hostname !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostname = this._hostname;
        }
        if (this._nodeName !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodeName = this._nodeName;
        }
        if (this._nodeSelector !== undefined) {
            hasAnyValues = true;
            internalValueResult.nodeSelector = this._nodeSelector;
        }
        if (this._priorityClassName !== undefined) {
            hasAnyValues = true;
            internalValueResult.priorityClassName = this._priorityClassName;
        }
        if (this._restartPolicy !== undefined) {
            hasAnyValues = true;
            internalValueResult.restartPolicy = this._restartPolicy;
        }
        if (this._runtimeClassName !== undefined) {
            hasAnyValues = true;
            internalValueResult.runtimeClassName = this._runtimeClassName;
        }
        if (this._schedulerName !== undefined) {
            hasAnyValues = true;
            internalValueResult.schedulerName = this._schedulerName;
        }
        if (this._serviceAccountName !== undefined) {
            hasAnyValues = true;
            internalValueResult.serviceAccountName = this._serviceAccountName;
        }
        if (this._shareProcessNamespace !== undefined) {
            hasAnyValues = true;
            internalValueResult.shareProcessNamespace = this._shareProcessNamespace;
        }
        if (this._subdomain !== undefined) {
            hasAnyValues = true;
            internalValueResult.subdomain = this._subdomain;
        }
        if (this._terminationGracePeriodSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.terminationGracePeriodSeconds = this._terminationGracePeriodSeconds;
        }
        if (this._affinity?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.affinity = this._affinity?.internalValue;
        }
        if (this._container?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.container = this._container?.internalValue;
        }
        if (this._dnsConfig?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.dnsConfig = this._dnsConfig?.internalValue;
        }
        if (this._hostAliases?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.hostAliases = this._hostAliases?.internalValue;
        }
        if (this._imagePullSecrets?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.imagePullSecrets = this._imagePullSecrets?.internalValue;
        }
        if (this._initContainer?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.initContainer = this._initContainer?.internalValue;
        }
        if (this._os?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.os = this._os?.internalValue;
        }
        if (this._readinessGate?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.readinessGate = this._readinessGate?.internalValue;
        }
        if (this._securityContext?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.securityContext = this._securityContext?.internalValue;
        }
        if (this._toleration?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.toleration = this._toleration?.internalValue;
        }
        if (this._topologySpreadConstraint?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.topologySpreadConstraint = this._topologySpreadConstraint?.internalValue;
        }
        if (this._volume?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.volume = this._volume?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._activeDeadlineSeconds = undefined;
            this._automountServiceAccountToken = undefined;
            this._dnsPolicy = undefined;
            this._enableServiceLinks = undefined;
            this._hostIpc = undefined;
            this._hostNetwork = undefined;
            this._hostPid = undefined;
            this._hostname = undefined;
            this._nodeName = undefined;
            this._nodeSelector = undefined;
            this._priorityClassName = undefined;
            this._restartPolicy = undefined;
            this._runtimeClassName = undefined;
            this._schedulerName = undefined;
            this._serviceAccountName = undefined;
            this._shareProcessNamespace = undefined;
            this._subdomain = undefined;
            this._terminationGracePeriodSeconds = undefined;
            this._affinity.internalValue = undefined;
            this._container.internalValue = undefined;
            this._dnsConfig.internalValue = undefined;
            this._hostAliases.internalValue = undefined;
            this._imagePullSecrets.internalValue = undefined;
            this._initContainer.internalValue = undefined;
            this._os.internalValue = undefined;
            this._readinessGate.internalValue = undefined;
            this._securityContext.internalValue = undefined;
            this._toleration.internalValue = undefined;
            this._topologySpreadConstraint.internalValue = undefined;
            this._volume.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._activeDeadlineSeconds = value.activeDeadlineSeconds;
            this._automountServiceAccountToken = value.automountServiceAccountToken;
            this._dnsPolicy = value.dnsPolicy;
            this._enableServiceLinks = value.enableServiceLinks;
            this._hostIpc = value.hostIpc;
            this._hostNetwork = value.hostNetwork;
            this._hostPid = value.hostPid;
            this._hostname = value.hostname;
            this._nodeName = value.nodeName;
            this._nodeSelector = value.nodeSelector;
            this._priorityClassName = value.priorityClassName;
            this._restartPolicy = value.restartPolicy;
            this._runtimeClassName = value.runtimeClassName;
            this._schedulerName = value.schedulerName;
            this._serviceAccountName = value.serviceAccountName;
            this._shareProcessNamespace = value.shareProcessNamespace;
            this._subdomain = value.subdomain;
            this._terminationGracePeriodSeconds = value.terminationGracePeriodSeconds;
            this._affinity.internalValue = value.affinity;
            this._container.internalValue = value.container;
            this._dnsConfig.internalValue = value.dnsConfig;
            this._hostAliases.internalValue = value.hostAliases;
            this._imagePullSecrets.internalValue = value.imagePullSecrets;
            this._initContainer.internalValue = value.initContainer;
            this._os.internalValue = value.os;
            this._readinessGate.internalValue = value.readinessGate;
            this._securityContext.internalValue = value.securityContext;
            this._toleration.internalValue = value.toleration;
            this._topologySpreadConstraint.internalValue = value.topologySpreadConstraint;
            this._volume.internalValue = value.volume;
        }
    }
    // active_deadline_seconds - computed: false, optional: true, required: false
    _activeDeadlineSeconds;
    get activeDeadlineSeconds() {
        return this.getNumberAttribute('active_deadline_seconds');
    }
    set activeDeadlineSeconds(value) {
        this._activeDeadlineSeconds = value;
    }
    resetActiveDeadlineSeconds() {
        this._activeDeadlineSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get activeDeadlineSecondsInput() {
        return this._activeDeadlineSeconds;
    }
    // automount_service_account_token - computed: false, optional: true, required: false
    _automountServiceAccountToken;
    get automountServiceAccountToken() {
        return this.getBooleanAttribute('automount_service_account_token');
    }
    set automountServiceAccountToken(value) {
        this._automountServiceAccountToken = value;
    }
    resetAutomountServiceAccountToken() {
        this._automountServiceAccountToken = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get automountServiceAccountTokenInput() {
        return this._automountServiceAccountToken;
    }
    // dns_policy - computed: false, optional: true, required: false
    _dnsPolicy;
    get dnsPolicy() {
        return this.getStringAttribute('dns_policy');
    }
    set dnsPolicy(value) {
        this._dnsPolicy = value;
    }
    resetDnsPolicy() {
        this._dnsPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get dnsPolicyInput() {
        return this._dnsPolicy;
    }
    // enable_service_links - computed: false, optional: true, required: false
    _enableServiceLinks;
    get enableServiceLinks() {
        return this.getBooleanAttribute('enable_service_links');
    }
    set enableServiceLinks(value) {
        this._enableServiceLinks = value;
    }
    resetEnableServiceLinks() {
        this._enableServiceLinks = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get enableServiceLinksInput() {
        return this._enableServiceLinks;
    }
    // host_ipc - computed: false, optional: true, required: false
    _hostIpc;
    get hostIpc() {
        return this.getBooleanAttribute('host_ipc');
    }
    set hostIpc(value) {
        this._hostIpc = value;
    }
    resetHostIpc() {
        this._hostIpc = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostIpcInput() {
        return this._hostIpc;
    }
    // host_network - computed: false, optional: true, required: false
    _hostNetwork;
    get hostNetwork() {
        return this.getBooleanAttribute('host_network');
    }
    set hostNetwork(value) {
        this._hostNetwork = value;
    }
    resetHostNetwork() {
        this._hostNetwork = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostNetworkInput() {
        return this._hostNetwork;
    }
    // host_pid - computed: false, optional: true, required: false
    _hostPid;
    get hostPid() {
        return this.getBooleanAttribute('host_pid');
    }
    set hostPid(value) {
        this._hostPid = value;
    }
    resetHostPid() {
        this._hostPid = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostPidInput() {
        return this._hostPid;
    }
    // hostname - computed: true, optional: true, required: false
    _hostname;
    get hostname() {
        return this.getStringAttribute('hostname');
    }
    set hostname(value) {
        this._hostname = value;
    }
    resetHostname() {
        this._hostname = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostnameInput() {
        return this._hostname;
    }
    // node_name - computed: true, optional: true, required: false
    _nodeName;
    get nodeName() {
        return this.getStringAttribute('node_name');
    }
    set nodeName(value) {
        this._nodeName = value;
    }
    resetNodeName() {
        this._nodeName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodeNameInput() {
        return this._nodeName;
    }
    // node_selector - computed: false, optional: true, required: false
    _nodeSelector;
    get nodeSelector() {
        return this.getStringMapAttribute('node_selector');
    }
    set nodeSelector(value) {
        this._nodeSelector = value;
    }
    resetNodeSelector() {
        this._nodeSelector = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get nodeSelectorInput() {
        return this._nodeSelector;
    }
    // priority_class_name - computed: false, optional: true, required: false
    _priorityClassName;
    get priorityClassName() {
        return this.getStringAttribute('priority_class_name');
    }
    set priorityClassName(value) {
        this._priorityClassName = value;
    }
    resetPriorityClassName() {
        this._priorityClassName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get priorityClassNameInput() {
        return this._priorityClassName;
    }
    // restart_policy - computed: false, optional: true, required: false
    _restartPolicy;
    get restartPolicy() {
        return this.getStringAttribute('restart_policy');
    }
    set restartPolicy(value) {
        this._restartPolicy = value;
    }
    resetRestartPolicy() {
        this._restartPolicy = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get restartPolicyInput() {
        return this._restartPolicy;
    }
    // runtime_class_name - computed: false, optional: true, required: false
    _runtimeClassName;
    get runtimeClassName() {
        return this.getStringAttribute('runtime_class_name');
    }
    set runtimeClassName(value) {
        this._runtimeClassName = value;
    }
    resetRuntimeClassName() {
        this._runtimeClassName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get runtimeClassNameInput() {
        return this._runtimeClassName;
    }
    // scheduler_name - computed: true, optional: true, required: false
    _schedulerName;
    get schedulerName() {
        return this.getStringAttribute('scheduler_name');
    }
    set schedulerName(value) {
        this._schedulerName = value;
    }
    resetSchedulerName() {
        this._schedulerName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get schedulerNameInput() {
        return this._schedulerName;
    }
    // service_account_name - computed: true, optional: true, required: false
    _serviceAccountName;
    get serviceAccountName() {
        return this.getStringAttribute('service_account_name');
    }
    set serviceAccountName(value) {
        this._serviceAccountName = value;
    }
    resetServiceAccountName() {
        this._serviceAccountName = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get serviceAccountNameInput() {
        return this._serviceAccountName;
    }
    // share_process_namespace - computed: false, optional: true, required: false
    _shareProcessNamespace;
    get shareProcessNamespace() {
        return this.getBooleanAttribute('share_process_namespace');
    }
    set shareProcessNamespace(value) {
        this._shareProcessNamespace = value;
    }
    resetShareProcessNamespace() {
        this._shareProcessNamespace = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get shareProcessNamespaceInput() {
        return this._shareProcessNamespace;
    }
    // subdomain - computed: false, optional: true, required: false
    _subdomain;
    get subdomain() {
        return this.getStringAttribute('subdomain');
    }
    set subdomain(value) {
        this._subdomain = value;
    }
    resetSubdomain() {
        this._subdomain = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get subdomainInput() {
        return this._subdomain;
    }
    // termination_grace_period_seconds - computed: false, optional: true, required: false
    _terminationGracePeriodSeconds;
    get terminationGracePeriodSeconds() {
        return this.getNumberAttribute('termination_grace_period_seconds');
    }
    set terminationGracePeriodSeconds(value) {
        this._terminationGracePeriodSeconds = value;
    }
    resetTerminationGracePeriodSeconds() {
        this._terminationGracePeriodSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get terminationGracePeriodSecondsInput() {
        return this._terminationGracePeriodSeconds;
    }
    // affinity - computed: false, optional: true, required: false
    _affinity = new DeploymentSpecTemplateSpecAffinityOutputReference(this, "affinity");
    get affinity() {
        return this._affinity;
    }
    putAffinity(value) {
        this._affinity.internalValue = value;
    }
    resetAffinity() {
        this._affinity.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get affinityInput() {
        return this._affinity.internalValue;
    }
    // container - computed: false, optional: true, required: false
    _container = new DeploymentSpecTemplateSpecContainerList(this, "container", false);
    get container() {
        return this._container;
    }
    putContainer(value) {
        this._container.internalValue = value;
    }
    resetContainer() {
        this._container.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get containerInput() {
        return this._container.internalValue;
    }
    // dns_config - computed: false, optional: true, required: false
    _dnsConfig = new DeploymentSpecTemplateSpecDnsConfigOutputReference(this, "dns_config");
    get dnsConfig() {
        return this._dnsConfig;
    }
    putDnsConfig(value) {
        this._dnsConfig.internalValue = value;
    }
    resetDnsConfig() {
        this._dnsConfig.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get dnsConfigInput() {
        return this._dnsConfig.internalValue;
    }
    // host_aliases - computed: false, optional: true, required: false
    _hostAliases = new DeploymentSpecTemplateSpecHostAliasesList(this, "host_aliases", false);
    get hostAliases() {
        return this._hostAliases;
    }
    putHostAliases(value) {
        this._hostAliases.internalValue = value;
    }
    resetHostAliases() {
        this._hostAliases.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get hostAliasesInput() {
        return this._hostAliases.internalValue;
    }
    // image_pull_secrets - computed: false, optional: true, required: false
    _imagePullSecrets = new DeploymentSpecTemplateSpecImagePullSecretsList(this, "image_pull_secrets", false);
    get imagePullSecrets() {
        return this._imagePullSecrets;
    }
    putImagePullSecrets(value) {
        this._imagePullSecrets.internalValue = value;
    }
    resetImagePullSecrets() {
        this._imagePullSecrets.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get imagePullSecretsInput() {
        return this._imagePullSecrets.internalValue;
    }
    // init_container - computed: false, optional: true, required: false
    _initContainer = new DeploymentSpecTemplateSpecInitContainerList(this, "init_container", false);
    get initContainer() {
        return this._initContainer;
    }
    putInitContainer(value) {
        this._initContainer.internalValue = value;
    }
    resetInitContainer() {
        this._initContainer.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get initContainerInput() {
        return this._initContainer.internalValue;
    }
    // os - computed: false, optional: true, required: false
    _os = new DeploymentSpecTemplateSpecOsOutputReference(this, "os");
    get os() {
        return this._os;
    }
    putOs(value) {
        this._os.internalValue = value;
    }
    resetOs() {
        this._os.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get osInput() {
        return this._os.internalValue;
    }
    // readiness_gate - computed: false, optional: true, required: false
    _readinessGate = new DeploymentSpecTemplateSpecReadinessGateList(this, "readiness_gate", false);
    get readinessGate() {
        return this._readinessGate;
    }
    putReadinessGate(value) {
        this._readinessGate.internalValue = value;
    }
    resetReadinessGate() {
        this._readinessGate.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get readinessGateInput() {
        return this._readinessGate.internalValue;
    }
    // security_context - computed: false, optional: true, required: false
    _securityContext = new DeploymentSpecTemplateSpecSecurityContextOutputReference(this, "security_context");
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
    // toleration - computed: false, optional: true, required: false
    _toleration = new DeploymentSpecTemplateSpecTolerationList(this, "toleration", false);
    get toleration() {
        return this._toleration;
    }
    putToleration(value) {
        this._toleration.internalValue = value;
    }
    resetToleration() {
        this._toleration.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get tolerationInput() {
        return this._toleration.internalValue;
    }
    // topology_spread_constraint - computed: false, optional: true, required: false
    _topologySpreadConstraint = new DeploymentSpecTemplateSpecTopologySpreadConstraintList(this, "topology_spread_constraint", false);
    get topologySpreadConstraint() {
        return this._topologySpreadConstraint;
    }
    putTopologySpreadConstraint(value) {
        this._topologySpreadConstraint.internalValue = value;
    }
    resetTopologySpreadConstraint() {
        this._topologySpreadConstraint.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get topologySpreadConstraintInput() {
        return this._topologySpreadConstraint.internalValue;
    }
    // volume - computed: false, optional: true, required: false
    _volume = new DeploymentSpecTemplateSpecVolumeList(this, "volume", false);
    get volume() {
        return this._volume;
    }
    putVolume(value) {
        this._volume.internalValue = value;
    }
    resetVolume() {
        this._volume.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get volumeInput() {
        return this._volume.internalValue;
    }
}
export function deploymentSpecTemplateToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        metadata: deploymentSpecTemplateMetadataToTerraform(struct.metadata),
        spec: deploymentSpecTemplateSpecToTerraform(struct.spec),
    };
}
export function deploymentSpecTemplateToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        metadata: {
            value: deploymentSpecTemplateMetadataToHclTerraform(struct.metadata),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateMetadataList",
        },
        spec: {
            value: deploymentSpecTemplateSpecToHclTerraform(struct.spec),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateSpecList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecTemplateOutputReference extends cdktf.ComplexObject {
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
        if (this._metadata?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.metadata = this._metadata?.internalValue;
        }
        if (this._spec?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.spec = this._spec?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._metadata.internalValue = undefined;
            this._spec.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._metadata.internalValue = value.metadata;
            this._spec.internalValue = value.spec;
        }
    }
    // metadata - computed: false, optional: false, required: true
    _metadata = new DeploymentSpecTemplateMetadataOutputReference(this, "metadata");
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
    _spec = new DeploymentSpecTemplateSpecOutputReference(this, "spec");
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
}
export function deploymentSpecToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        min_ready_seconds: cdktf.numberToTerraform(struct.minReadySeconds),
        paused: cdktf.booleanToTerraform(struct.paused),
        progress_deadline_seconds: cdktf.numberToTerraform(struct.progressDeadlineSeconds),
        replicas: cdktf.stringToTerraform(struct.replicas),
        revision_history_limit: cdktf.numberToTerraform(struct.revisionHistoryLimit),
        selector: deploymentSpecSelectorToTerraform(struct.selector),
        strategy: deploymentSpecStrategyToTerraform(struct.strategy),
        template: deploymentSpecTemplateToTerraform(struct.template),
    };
}
export function deploymentSpecToHclTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    const attrs = {
        min_ready_seconds: {
            value: cdktf.numberToHclTerraform(struct.minReadySeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        paused: {
            value: cdktf.booleanToHclTerraform(struct.paused),
            isBlock: false,
            type: "simple",
            storageClassType: "boolean",
        },
        progress_deadline_seconds: {
            value: cdktf.numberToHclTerraform(struct.progressDeadlineSeconds),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        replicas: {
            value: cdktf.stringToHclTerraform(struct.replicas),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        revision_history_limit: {
            value: cdktf.numberToHclTerraform(struct.revisionHistoryLimit),
            isBlock: false,
            type: "simple",
            storageClassType: "number",
        },
        selector: {
            value: deploymentSpecSelectorToHclTerraform(struct.selector),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecSelectorList",
        },
        strategy: {
            value: deploymentSpecStrategyToHclTerraform(struct.strategy),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecStrategyList",
        },
        template: {
            value: deploymentSpecTemplateToHclTerraform(struct.template),
            isBlock: true,
            type: "list",
            storageClassType: "DeploymentSpecTemplateList",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentSpecOutputReference extends cdktf.ComplexObject {
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
        if (this._minReadySeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.minReadySeconds = this._minReadySeconds;
        }
        if (this._paused !== undefined) {
            hasAnyValues = true;
            internalValueResult.paused = this._paused;
        }
        if (this._progressDeadlineSeconds !== undefined) {
            hasAnyValues = true;
            internalValueResult.progressDeadlineSeconds = this._progressDeadlineSeconds;
        }
        if (this._replicas !== undefined) {
            hasAnyValues = true;
            internalValueResult.replicas = this._replicas;
        }
        if (this._revisionHistoryLimit !== undefined) {
            hasAnyValues = true;
            internalValueResult.revisionHistoryLimit = this._revisionHistoryLimit;
        }
        if (this._selector?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.selector = this._selector?.internalValue;
        }
        if (this._strategy?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.strategy = this._strategy?.internalValue;
        }
        if (this._template?.internalValue !== undefined) {
            hasAnyValues = true;
            internalValueResult.template = this._template?.internalValue;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this._minReadySeconds = undefined;
            this._paused = undefined;
            this._progressDeadlineSeconds = undefined;
            this._replicas = undefined;
            this._revisionHistoryLimit = undefined;
            this._selector.internalValue = undefined;
            this._strategy.internalValue = undefined;
            this._template.internalValue = undefined;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this._minReadySeconds = value.minReadySeconds;
            this._paused = value.paused;
            this._progressDeadlineSeconds = value.progressDeadlineSeconds;
            this._replicas = value.replicas;
            this._revisionHistoryLimit = value.revisionHistoryLimit;
            this._selector.internalValue = value.selector;
            this._strategy.internalValue = value.strategy;
            this._template.internalValue = value.template;
        }
    }
    // min_ready_seconds - computed: false, optional: true, required: false
    _minReadySeconds;
    get minReadySeconds() {
        return this.getNumberAttribute('min_ready_seconds');
    }
    set minReadySeconds(value) {
        this._minReadySeconds = value;
    }
    resetMinReadySeconds() {
        this._minReadySeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get minReadySecondsInput() {
        return this._minReadySeconds;
    }
    // paused - computed: false, optional: true, required: false
    _paused;
    get paused() {
        return this.getBooleanAttribute('paused');
    }
    set paused(value) {
        this._paused = value;
    }
    resetPaused() {
        this._paused = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get pausedInput() {
        return this._paused;
    }
    // progress_deadline_seconds - computed: false, optional: true, required: false
    _progressDeadlineSeconds;
    get progressDeadlineSeconds() {
        return this.getNumberAttribute('progress_deadline_seconds');
    }
    set progressDeadlineSeconds(value) {
        this._progressDeadlineSeconds = value;
    }
    resetProgressDeadlineSeconds() {
        this._progressDeadlineSeconds = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get progressDeadlineSecondsInput() {
        return this._progressDeadlineSeconds;
    }
    // replicas - computed: true, optional: true, required: false
    _replicas;
    get replicas() {
        return this.getStringAttribute('replicas');
    }
    set replicas(value) {
        this._replicas = value;
    }
    resetReplicas() {
        this._replicas = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get replicasInput() {
        return this._replicas;
    }
    // revision_history_limit - computed: false, optional: true, required: false
    _revisionHistoryLimit;
    get revisionHistoryLimit() {
        return this.getNumberAttribute('revision_history_limit');
    }
    set revisionHistoryLimit(value) {
        this._revisionHistoryLimit = value;
    }
    resetRevisionHistoryLimit() {
        this._revisionHistoryLimit = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get revisionHistoryLimitInput() {
        return this._revisionHistoryLimit;
    }
    // selector - computed: false, optional: true, required: false
    _selector = new DeploymentSpecSelectorOutputReference(this, "selector");
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
    // strategy - computed: false, optional: true, required: false
    _strategy = new DeploymentSpecStrategyOutputReference(this, "strategy");
    get strategy() {
        return this._strategy;
    }
    putStrategy(value) {
        this._strategy.internalValue = value;
    }
    resetStrategy() {
        this._strategy.internalValue = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get strategyInput() {
        return this._strategy.internalValue;
    }
    // template - computed: false, optional: false, required: true
    _template = new DeploymentSpecTemplateOutputReference(this, "template");
    get template() {
        return this._template;
    }
    putTemplate(value) {
        this._template.internalValue = value;
    }
    // Temporarily expose input value. Use with caution.
    get templateInput() {
        return this._template.internalValue;
    }
}
export function deploymentTimeoutsToTerraform(struct) {
    if (!cdktf.canInspect(struct) || cdktf.Tokenization.isResolvable(struct)) {
        return struct;
    }
    if (cdktf.isComplexElement(struct)) {
        throw new Error("A complex element was used as configuration, this is not supported: https://cdk.tf/complex-object-as-configuration");
    }
    return {
        create: cdktf.stringToTerraform(struct.create),
        delete: cdktf.stringToTerraform(struct.delete),
        update: cdktf.stringToTerraform(struct.update),
    };
}
export function deploymentTimeoutsToHclTerraform(struct) {
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
        delete: {
            value: cdktf.stringToHclTerraform(struct.delete),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
        update: {
            value: cdktf.stringToHclTerraform(struct.update),
            isBlock: false,
            type: "simple",
            storageClassType: "string",
        },
    };
    // remove undefined attributes
    return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
}
export class DeploymentTimeoutsOutputReference extends cdktf.ComplexObject {
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
        if (this._delete !== undefined) {
            hasAnyValues = true;
            internalValueResult.delete = this._delete;
        }
        if (this._update !== undefined) {
            hasAnyValues = true;
            internalValueResult.update = this._update;
        }
        return hasAnyValues ? internalValueResult : undefined;
    }
    set internalValue(value) {
        if (value === undefined) {
            this.isEmptyObject = false;
            this.resolvableValue = undefined;
            this._create = undefined;
            this._delete = undefined;
            this._update = undefined;
        }
        else if (cdktf.Tokenization.isResolvable(value)) {
            this.isEmptyObject = false;
            this.resolvableValue = value;
        }
        else {
            this.isEmptyObject = Object.keys(value).length === 0;
            this.resolvableValue = undefined;
            this._create = value.create;
            this._delete = value.delete;
            this._update = value.update;
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
    // update - computed: false, optional: true, required: false
    _update;
    get update() {
        return this.getStringAttribute('update');
    }
    set update(value) {
        this._update = value;
    }
    resetUpdate() {
        this._update = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get updateInput() {
        return this._update;
    }
}
