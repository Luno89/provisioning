// generated from terraform resource schema
import { deploymentMetadataToTerraform, deploymentMetadataToHclTerraform, DeploymentMetadataOutputReference, deploymentSpecToTerraform, deploymentSpecToHclTerraform, DeploymentSpecOutputReference, deploymentTimeoutsToTerraform, deploymentTimeoutsToHclTerraform, DeploymentTimeoutsOutputReference } from './index-structs';
export * from './index-structs';
import * as cdktf from 'cdktf';
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment kubernetes_deployment}
*/
export class Deployment extends cdktf.TerraformResource {
    // =================
    // STATIC PROPERTIES
    // =================
    static tfResourceType = "kubernetes_deployment";
    // ==============
    // STATIC Methods
    // ==============
    /**
    * Generates CDKTF code for importing a Deployment resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Deployment to import
    * @param importFromId The id of the existing Deployment that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Deployment to import is found
    */
    static generateConfigForImport(scope, importToId, importFromId, provider) {
        return new cdktf.ImportableResource(scope, importToId, { terraformResourceType: "kubernetes_deployment", importId: importFromId, provider });
    }
    // ===========
    // INITIALIZER
    // ===========
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment kubernetes_deployment} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options DeploymentConfig
    */
    constructor(scope, id, config) {
        super(scope, id, {
            terraformResourceType: 'kubernetes_deployment',
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
        this._waitForRollout = config.waitForRollout;
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
    // wait_for_rollout - computed: false, optional: true, required: false
    _waitForRollout;
    get waitForRollout() {
        return this.getBooleanAttribute('wait_for_rollout');
    }
    set waitForRollout(value) {
        this._waitForRollout = value;
    }
    resetWaitForRollout() {
        this._waitForRollout = undefined;
    }
    // Temporarily expose input value. Use with caution.
    get waitForRolloutInput() {
        return this._waitForRollout;
    }
    // metadata - computed: false, optional: false, required: true
    _metadata = new DeploymentMetadataOutputReference(this, "metadata");
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
    _spec = new DeploymentSpecOutputReference(this, "spec");
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
    _timeouts = new DeploymentTimeoutsOutputReference(this, "timeouts");
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
            wait_for_rollout: cdktf.booleanToTerraform(this._waitForRollout),
            metadata: deploymentMetadataToTerraform(this._metadata.internalValue),
            spec: deploymentSpecToTerraform(this._spec.internalValue),
            timeouts: deploymentTimeoutsToTerraform(this._timeouts.internalValue),
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
            wait_for_rollout: {
                value: cdktf.booleanToHclTerraform(this._waitForRollout),
                isBlock: false,
                type: "simple",
                storageClassType: "boolean",
            },
            metadata: {
                value: deploymentMetadataToHclTerraform(this._metadata.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "DeploymentMetadataList",
            },
            spec: {
                value: deploymentSpecToHclTerraform(this._spec.internalValue),
                isBlock: true,
                type: "list",
                storageClassType: "DeploymentSpecList",
            },
            timeouts: {
                value: deploymentTimeoutsToHclTerraform(this._timeouts.internalValue),
                isBlock: true,
                type: "struct",
                storageClassType: "DeploymentTimeouts",
            },
        };
        // remove undefined attributes
        return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined));
    }
}
