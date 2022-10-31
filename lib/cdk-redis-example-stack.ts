
// import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, CfnOutput, aws_apprunner, aws_iam } from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { aws_rds as rds } from 'aws-cdk-lib';
import * as apprunner from '@aws-cdk/aws-apprunner-alpha';
import { Construct } from 'constructs';
const path = require('path');

export class CdkRedisExampleStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create VPC for use with Postgres
    const appVpc = new ec2.Vpc(this, `AppVpc-${id}`, {
      cidr: "11.192.0.0/16",
      maxAzs: 2,
      natGateways: 0,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      /**
       * Each entry in this list configures a Subnet Group
       *
       * PRIVATE_ISOLATED: Isolated Subnets do not route traffic to the Internet (in this VPC).
       * PRIVATE_WITH_NAT.: Subnet that routes to the internet, but not vice versa.
       * PUBLIC..: Subnet connected to the Internet.
       */
      subnetConfiguration: [{
        cidrMask: 24,
        name: 'db',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }, {
        cidrMask: 24,
        name: 'dmz',
        subnetType: ec2.SubnetType.PUBLIC,
      }],
    });

    let isolatedSubnets: string[] = []
    appVpc.isolatedSubnets.forEach(function(value){
      isolatedSubnets.push(value.subnetId)
    });
    let publicSubnets: string[] = []
    appVpc.publicSubnets.forEach(function(value){
      publicSubnets.push(value.subnetId)
    });




    const rdsSecurityGroup = new ec2.SecurityGroup(this, `DatabaseSG-${id}`, {
      vpc: appVpc,
      description: 'SecurityGroup associated with the RDS Cluster',
      securityGroupName: `DatabaseSG`
    });
    new ec2.CfnSecurityGroupIngress(this, `DatabaseSGIngress-${id}`, {
      groupId: rdsSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      toPort: 5432,
      fromPort: 5432,
      sourceSecurityGroupId: rdsSecurityGroup.securityGroupId
    });


    const subnetGroup = new rds.SubnetGroup(this, `SubnetGroup-${id}`, {
      vpc: appVpc,
      description: "Subnet Group for RDS",
      vpcSubnets: appVpc.selectSubnets({
        onePerAz: true,
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      })
    });

    // This is an Aurora RDS instance, not just Classic RDS
    const cluster = new rds.DatabaseCluster(this, `Database-${id}`, {
      engine: rds.DatabaseClusterEngine.auroraPostgres({version: rds.AuroraPostgresEngineVersion.VER_13_4}),
      defaultDatabaseName: "app",
      instances: 2,
      instanceProps: {
        // Smallest supported instance type (~$50/month/instance)
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MEDIUM),
        vpc: appVpc,
        securityGroups: [rdsSecurityGroup]
      },
      subnetGroup,
    });


    const bastionSecurityGroup = new ec2.SecurityGroup(this, `BastionSecurityGroup-${id}`, {
      vpc: appVpc,
      allowAllOutbound: true,
      description: 'Security group for bastion host',
      securityGroupName: 'BastionSecurityGroup'
    });
    new ec2.CfnSecurityGroupIngress(this, `DatabaseSGIngressBastion-${id}`, {
      groupId: rdsSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      toPort: 5432,
      fromPort: 5432,
      sourceSecurityGroupId: bastionSecurityGroup.securityGroupId
    });


    const bastionHostLinux = new ec2.BastionHostLinux(this, `BastionInstance-${id}`, {
      vpc: appVpc,
      securityGroup: bastionSecurityGroup,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC
      },
    });
         
    // Command to connect to Postgres database locally
    // Each user would need to have IAM permissions to run the SSM start-session command.
    const sshTunnelCommandRds = `aws ssm start-session`+
    ` --target ${bastionHostLinux.instanceId}`+
    ` --document-name AWS-StartPortForwardingSessionToRemoteHost` +
    ` --parameters '{"host":["${cluster.clusterEndpoint.hostname}"],"portNumber":["5432"], "localPortNumber":["5433"]}'`

    new CfnOutput(this, `sshTunnelCommandRds-${id}`, { value: sshTunnelCommandRds });


    // Allows App Runner to connect to your VPC (database)
    const vpcConnector = new apprunner.VpcConnector(this, `AppRunnerVpcConnector-${id}`, {
      vpc: appVpc,
      vpcSubnets: appVpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_ISOLATED}),
      vpcConnectorName: `AppRunnerVpcConnector-${id}`,
      securityGroups: [rdsSecurityGroup]
    });

    const appRunnerIAMRole = new aws_iam.Role(this, '', {
      assumedBy: new aws_iam.ServicePrincipal('apprunner.amazonaws.com'),
    })

    // This should be completed and made more accurate for your needs.
    appRunnerIAMRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: ['*'],
      })
    );


    // Deploy a node app from github
    const appRunnerFromGithub = new apprunner.Service(this, `BackendAppFromGithub-${id}`, {
      serviceName: `AppFromGithub-${id}`,
      vpcConnector,
      instanceRole: appRunnerIAMRole,
      source: apprunner.Source.fromGitHub({
        // These would be changed to your repository that is running your node app
        repositoryUrl: 'https://github.com/shafkevi/cdk-redis-example',
        branch: 'pg-only',
        configurationSource: apprunner.ConfigurationSourceType.API,
        // Ensure to create this github connection.
        connection: apprunner.GitHubConnection.fromConnectionArn(process.env.GITHUB_CONNECTION_ARN || ''),
        codeConfigurationValues: {
          runtime: apprunner.Runtime.NODEJS_12,
          port: "8080",
          // these commands should reflect your node app
          buildCommand: "mv ./api/* .; npm install",
          startCommand: "npm run start",
          // Should upgrade to use Secrets Manager
          environment: {
            "PG_HOST": cluster.secret?.secretValueFromJson("host").toString() || cluster.clusterEndpoint.hostname,
            "PG_PORT": cluster.secret?.secretValueFromJson("port").toString() || "5432",
            "PG_DATABASE": cluster.secret?.secretValueFromJson("dbname").toString() || "app",
            "PG_USER": cluster.secret?.secretValueFromJson("username").toString() || "postgres",
            "PG_PASSWORD": cluster.secret?.secretValueFromJson("password").toString() || ""
          }
        }
      }),
    });

    // Automatically run builds on push to this github repository
    try {
      const cfnApprunnerService = appRunnerFromGithub.node.defaultChild as aws_apprunner.CfnService;
      cfnApprunnerService.addPropertyOverride('SourceConfiguration.AutoDeploymentsEnabled', true);
    }
    catch (e){
      console.log(e);
    }

    // Output the VPC ID
    new CfnOutput(this, `AppVpcId-${id}`, {
      value: appVpc.vpcId,
      description: "App VPC ID",
      exportName: `AppVpcId-${id}`
    });



    // Output the AppRunner URL
    new CfnOutput(this, `AppRunnerURL-${id}`, {
      value: appRunnerFromGithub.serviceUrl,
      description: "AppRunnerURL",
      exportName: `AppRunnerURL-${id}`
    });



  }
}