
// import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, CfnOutput, Aws } from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { aws_elasticache as elasticache } from 'aws-cdk-lib';
import { aws_rds as rds } from 'aws-cdk-lib';
import { aws_ecr_assets as ecs_assets } from 'aws-cdk-lib';
import * as apprunner from '@aws-cdk/aws-apprunner-alpha';
import { Construct } from 'constructs';
const path = require('path');

export class CdkRedisExampleStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create VPC for use with Redis/Postgres
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

    const elastiCacheSecurityGroup = new ec2.SecurityGroup(this, `ElastiCacheSG-${id}`, {
      vpc: appVpc,
      description: 'SecurityGroup associated with the ElastiCache Redis Cluster',
      securityGroupName: 'ElastiCacheSG'
      // securityGroupName: `ElastiCacheSG-${id}`

    });

    new ec2.CfnSecurityGroupIngress(this, `ElastiCacheSGIngress-${id}`, {
      groupId: elastiCacheSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      toPort: 6379,
      fromPort: 6379,
      sourceSecurityGroupId: elastiCacheSecurityGroup.securityGroupId
    });

    const ecSubnetGroup = new elasticache.CfnSubnetGroup(this, `ElastiCacheSubnetGroup-${id}`, {
      description: 'Elasticache Subnet Group',
      subnetIds: isolatedSubnets,
      cacheSubnetGroupName: `RedisSubnetGroup-${id}`
    });


    const elastiCacheCluster = new elasticache.CfnReplicationGroup(this, `redisCacheCluster-${id}`, {
      replicationGroupDescription: `Redis Cluster - ${id}`,
      cacheNodeType: 'cache.t4g.small',
      engine: "redis",
      engineVersion: '6.x',
      multiAzEnabled: true,
      numNodeGroups: 1,
      replicasPerNodeGroup: 1,
      cacheSubnetGroupName: ecSubnetGroup.cacheSubnetGroupName,
      securityGroupIds: [elastiCacheSecurityGroup.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
    })





    const rdsSecurityGroup = new ec2.SecurityGroup(this, `DatabaseSG-${id}`, {
      vpc: appVpc,
      description: 'SecurityGroup associated with the RDS Cluster',
      securityGroupName: `DatabaseSG`
      // securityGroupName: `DatabaseSG-${id}`

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
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MEDIUM),
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

    new ec2.CfnSecurityGroupIngress(this, `ElastiCacheSGIngressBastion-${id}`, {
      groupId: elastiCacheSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      toPort: 6379,
      fromPort: 6379,
      sourceSecurityGroupId: bastionSecurityGroup.securityGroupId
    });


    const bastionHostLinux = new ec2.BastionHostLinux(this, `BastionInstance-${id}`, {
      vpc: appVpc,
      securityGroup: bastionSecurityGroup,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC
      },
    });
         
    const sshTunnelCommandRds = `aws ssm start-session`+
    ` --target ${bastionHostLinux.instanceId}`+
    ` --document-name AWS-StartPortForwardingSessionToRemoteHost` +
    ` --parameters '{"host":["${cluster.clusterEndpoint.hostname}"],"portNumber":["5432"], "localPortNumber":["5433"]}'`
    const sshTunnelCommandEC = `aws ssm start-session`+
    ` --target ${bastionHostLinux.instanceId}`+
    ` --document-name AWS-StartPortForwardingSessionToRemoteHost` +
    ` --parameters '{"host":["${elastiCacheCluster.attrPrimaryEndPointAddress}"],"portNumber":["6379"], "localPortNumber":["6380"]}'`


    new CfnOutput(this, `sshTunnelCommandRds-${id}`, { value: sshTunnelCommandRds });
    new CfnOutput(this, `sshTunnelCommandEC-${id}`, { value: sshTunnelCommandEC });


    const vpcConnector = new apprunner.VpcConnector(this, `AppRunnerVpcConnector-${id}`, {
      vpc: appVpc,
      vpcSubnets: appVpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_ISOLATED}),
      // vpcConnectorName: `AppRunnerVpcConnector-${id}`,
      vpcConnectorName: `AppRunnerVpcConnector`,
      securityGroups: [rdsSecurityGroup, elastiCacheSecurityGroup]
    });


    const imageAsset = new ecs_assets.DockerImageAsset(this, 'apiImage', {
      directory: path.join(__dirname, '..','./api')
    });

    // should use secrets manager instead of env variables... but we'll figure that out later.
    const appRunnerFromAssets = new apprunner.Service(this, `BackendAppFromAssets-${id}`, {
      serviceName: `AppFromAssets-${id}`,
      vpcConnector,
      source: apprunner.Source.fromAsset({
        imageConfiguration: {
          port: 8080,
          environment: {
            "PG_HOST": cluster.secret?.secretValueFromJson("host").toString() || cluster.clusterEndpoint.hostname,
            "PG_PORT": cluster.secret?.secretValueFromJson("port").toString() || "5432",
            "PG_DATABASE": cluster.secret?.secretValueFromJson("dbname").toString() || "app",
            "PG_USER": cluster.secret?.secretValueFromJson("username").toString() || "postgres",
            "PG_PASSWORD": cluster.secret?.secretValueFromJson("password").toString() || "",
            "REDIS_HOST": elastiCacheCluster.attrPrimaryEndPointAddress,
            "REDIS_PORT": elastiCacheCluster.attrPrimaryEndPointPort
          }
        },
        asset: imageAsset

      })
    });



    // Deploy a node app from github
    const appRunnerFromGithub = new apprunner.Service(this, `BackendAppFromGithub-${id}`, {
      serviceName: `AppFromGithub-${id}`,
      vpcConnector,
      source: apprunner.Source.fromGitHub({
        // These would be changed to your repository
        // Should update it to self reference this repository.
        repositoryUrl: 'https://github.com/shafkevi/cdk-redis-example',
        branch: 'pg-only',
        configurationSource: apprunner.ConfigurationSourceType.API,
        connection: apprunner.GitHubConnection.fromConnectionArn(process.env.GITHUB_CONNECTION_ARN || ''),
        codeConfigurationValues: {
          runtime: apprunner.Runtime.NODEJS_12,
          port: "8080",
          buildCommand: "cd api && npm install",
          startCommand: "cd api && npm run start",
          environment: {
            "PG_HOST": cluster.secret?.secretValueFromJson("host").toString() || cluster.clusterEndpoint.hostname,
            "PG_PORT": cluster.secret?.secretValueFromJson("port").toString() || "5432",
            "PG_DATABASE": cluster.secret?.secretValueFromJson("dbname").toString() || "app",
            "PG_USER": cluster.secret?.secretValueFromJson("username").toString() || "postgres",
            "PG_PASSWORD": cluster.secret?.secretValueFromJson("password").toString() || "",
            "REDIS_HOST": elastiCacheCluster.attrPrimaryEndPointAddress,
            "REDIS_PORT": elastiCacheCluster.attrPrimaryEndPointPort
          }
        }
      }),
    });

    new CfnOutput(this, `RedisPrimaryEndPointAddress-${id}`, {
      value: elastiCacheCluster.attrPrimaryEndPointAddress,
    });

    new CfnOutput(this, `RedisPrimaryEndPointPort-${id}`, {
      value: elastiCacheCluster.attrPrimaryEndPointPort,
    });

    // new CfnOutput(this, `RedisReadEndPointAddresses-${id}`, {
    //   value: elastiCacheCluster.attrReadEndPointAddresses,
    // });

    // new CfnOutput(this, `RedisReadEndPointPortsList-${id}`, {
    //   value: elastiCacheCluster.attrReadEndPointPorts,
    // });

    /*
    // If you only want a single instance with no replication
    const elastiCacheCluster = new elasticache.CfnCacheCluster(this, `V2redisCacheCluster-${id}`, {
      clusterName: 'Redis Cluster',
      cacheNodeType: 'cache.t4g.small',
      engine: 'redis',
      autoMinorVersionUpgrade: true,
      numCacheNodes: 1,
      azMode: 'cross-az',
      cacheSubnetGroupName: ecSubnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [elastiCacheSecurityGroup.securityGroupId]
    })

    new CfnOutput(this, `V2RedisEndpointAddress-${id}`, {
      value: elastiCacheCluster.attrRedisEndpointAddress,
    });
    new CfnOutput(this, `V2RedisEndpointPort-${id}`, {
      value: elastiCacheCluster.attrRedisEndpointPort,
    });
    */

    elastiCacheCluster.node.addDependency(ecSubnetGroup)

    // Output the VPC ID
    new CfnOutput(this, `AppVpcId-${id}`, {
      value: appVpc.vpcId,
      description: "App VPC ID",
      exportName: `AppVpcId-${id}`
    });



  }
}