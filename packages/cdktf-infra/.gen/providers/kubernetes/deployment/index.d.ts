import { DeploymentMetadata, DeploymentSpec, DeploymentTimeouts } from './index-structs';
export * from './index-structs';
import { Construct } from 'constructs';
import * as cdktf from 'cdktf';
export interface DeploymentConfig extends cdktf.TerraformMetaArguments {
    /**
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment#id Deployment#id}
    *
    * Please be aware that the id field is automatically added to all resources in Terraform providers using a Terraform provider SDK version below 2.
    * If you experience problems setting this value it might not be settable. Please take a look at the provider documentation to ensure it should be settable.
    */
    readonly id?: string;
    /**
    * Wait for the rollout of the deployment to complete. Defaults to true.
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment#wait_for_rollout Deployment#wait_for_rollout}
    */
    readonly waitForRollout?: boolean | cdktf.IResolvable;
    /**
    * metadata block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment#metadata Deployment#metadata}
    */
    readonly metadata: DeploymentMetadata;
    /**
    * spec block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment#spec Deployment#spec}
    */
    readonly spec: DeploymentSpec;
    /**
    * timeouts block
    *
    * Docs at Terraform Registry: {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment#timeouts Deployment#timeouts}
    */
    readonly timeouts?: DeploymentTimeouts;
}
/**
* Represents a {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment kubernetes_deployment}
*/
export declare class Deployment extends cdktf.TerraformResource {
    static readonly tfResourceType = "kubernetes_deployment";
    /**
    * Generates CDKTF code for importing a Deployment resource upon running "cdktf plan <stack-name>"
    * @param scope The scope in which to define this construct
    * @param importToId The construct id used in the generated config for the Deployment to import
    * @param importFromId The id of the existing Deployment that should be imported. Refer to the {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment#import import section} in the documentation of this resource for the id to use
    * @param provider? Optional instance of the provider where the Deployment to import is found
    */
    static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktf.TerraformProvider): cdktf.ImportableResource;
    /**
    * Create a new {@link https://registry.terraform.io/providers/hashicorp/kubernetes/2.38.0/docs/resources/deployment kubernetes_deployment} Resource
    *
    * @param scope The scope in which to define this construct
    * @param id The scoped construct ID. Must be unique amongst siblings in the same scope
    * @param options DeploymentConfig
    */
    constructor(scope: Construct, id: string, config: DeploymentConfig);
    private _id?;
    get id(): string;
    set id(value: string);
    resetId(): void;
    get idInput(): string | undefined;
    private _waitForRollout?;
    get waitForRollout(): boolean | cdktf.IResolvable;
    set waitForRollout(value: boolean | cdktf.IResolvable);
    resetWaitForRollout(): void;
    get waitForRolloutInput(): boolean | cdktf.IResolvable | undefined;
    private _metadata;
    get metadata(): any;
    putMetadata(value: DeploymentMetadata): void;
    get metadataInput(): any;
    private _spec;
    get spec(): any;
    putSpec(value: DeploymentSpec): void;
    get specInput(): any;
    private _timeouts;
    get timeouts(): any;
    putTimeouts(value: DeploymentTimeouts): void;
    resetTimeouts(): void;
    get timeoutsInput(): any;
    protected synthesizeAttributes(): {
        [name: string]: any;
    };
    protected synthesizeHclAttributes(): {
        [name: string]: any;
    };
}
//# sourceMappingURL=index.d.ts.map