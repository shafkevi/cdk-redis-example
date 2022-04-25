
// import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { aws_elasticache as elasticache } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class CdkRedisExampleStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create VPC for use with Neptune
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


    const elastiCacheSecurityGroup = new ec2.CfnSecurityGroup(this, `ElastiCacheSG-${id}`, {
      vpcId: appVpc.vpcId,
      groupDescription: 'SecurityGroup associated with the ElastiCache Redis Cluster',
    });
    new ec2.CfnSecurityGroupIngress(this, `ElastiCacheSGIngress-${id}`, {
      groupId: elastiCacheSecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      toPort: 6379,
      fromPort: 6379,
      sourceSecurityGroupId: elastiCacheSecurityGroup.attrGroupId
    });

    let isolatedSubnets: string[] = []

    appVpc.isolatedSubnets.forEach(function(value){
      isolatedSubnets.push(value.subnetId)
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
      securityGroupIds: [elastiCacheSecurityGroup.attrGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
    })

    new CfnOutput(this, `RedisPrimaryEndPointAddress-${id}`, {
      value: elastiCacheCluster.attrPrimaryEndPointAddress,
    });

    new CfnOutput(this, `RedisPrimaryEndPointPort-${id}`, {
      value: elastiCacheCluster.attrPrimaryEndPointPort,
    });

    new CfnOutput(this, `RedisReadEndPointAddresses-${id}`, {
      value: elastiCacheCluster.attrReadEndPointAddresses,
    });

    new CfnOutput(this, `RedisReadEndPointPortsList-${id}`, {
      value: elastiCacheCluster.attrReadEndPointPorts,
    });

    /*
    // If you only want a single instance with no replication
    const elastiCacheCluster = new elasticache.CfnCacheCluster(this, 'V2redisCacheCluster', {
      clusterName: 'Redis Cluster',
      cacheNodeType: 'cache.t4g.small',
      engine: 'redis',
      autoMinorVersionUpgrade: true,
      numCacheNodes: 1,
      azMode: 'cross-az',
      cacheSubnetGroupName: ecSubnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [elastiCacheSecurityGroup.securityGroupId]
    })

    new CfnOutput(this, "V2RedisEndpointAddress", {
      value: elastiCacheCluster.attrRedisEndpointAddress,
    });
    new CfnOutput(this, "V2RedisEndpointPort", {
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