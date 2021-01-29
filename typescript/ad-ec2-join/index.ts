import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ad from '@aws-cdk/aws-directoryservice';
import * as sm from '@aws-cdk/aws-secretsmanager';
import * as ssm from '@aws-cdk/aws-ssm';
import * as iam from '@aws-cdk/aws-iam';

class AdFsxStack extends cdk.Stack {
  constructor(app: cdk.App, id: string, adDnsDomainName: string) {
    super(app, id);

    const vpc = new ec2.Vpc(this, 'VPC', {});

    const privateSubnets = vpc.privateSubnets.slice(0,2).map(x => x.subnetId)

    //Generate AD admin password and store in Secrets Manager
    const templatedSecret = new sm.Secret(this, adDnsDomainName + '_credentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password'
      },
    });

    //Create Active Directory
    const mad = new ad.CfnMicrosoftAD(this, 'ad', {
      name: adDnsDomainName,
      password: templatedSecret.secretValueFromJson('password').toString(),
      vpcSettings: {
        vpcId: vpc.vpcId,
        subnetIds: privateSubnets
      }
    })

    //Set VPC DHCP options for AD
    const dhcpOptions = new ec2.CfnDHCPOptions(this, 'dhcpOptions', {
      domainName: adDnsDomainName,
      domainNameServers: mad.attrDnsIpAddresses,
    })

    new ec2.CfnVPCDHCPOptionsAssociation(this, 'dhcpOptionsAssoc', {
      dhcpOptionsId: dhcpOptions.ref,
      vpcId: vpc.vpcId
    })
    
    //User data to add 'Active Directory Users and Computers mgmt tool to EC2 instance'
    const ud = ec2.UserData.forWindows()
    ud.addCommands('Add-WindowsFeature RSAT-Role-Tools')

    //EC2 instance, in public subnet so we can RDP to the instance
    const instance = new ec2.Instance(this, 'ad-joined-instance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.LARGE),
      vpc,
      machineImage: new ec2.WindowsImage(ec2.WindowsVersion.WINDOWS_SERVER_2019_ENGLISH_FULL_BASE),
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      userData: ud
    })

    //Add roles to instance profile for Domain Join via SSM
    const policies = ['AmazonSSMManagedInstanceCore','AmazonSSMDirectoryServiceAccess']
    policies.forEach((x) =>  instance.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(x)))

    //SSM Document
    const docContent = `{
      "schemaVersion": "1.0",
      "description": "Join an instance to a domain",
      "runtimeConfig": {
        "aws:domainJoin": {
          "properties": {
            "directoryId": "${mad.attrAlias}",
            "directoryName": "${adDnsDomainName}",
            "dnsIpAddresses": [
              "${cdk.Fn.select(0, mad.attrDnsIpAddresses)}",
              "${cdk.Fn.select(1, mad.attrDnsIpAddresses)}"
            ]
          }
        }
      }
    }`

    const ssmDoc = new ssm.CfnDocument(this, 'domainJoinDoc', {
      content: docContent,
      name: 'ad-join-domain',

    })

    new ssm.CfnAssociation(this, 'ssmAssociation', {
      name: ssmDoc.ref,
      instanceId: instance.instanceId
    })

    const outputs = [
      {"name":"directoryAlias","value":mad.attrAlias},
      {"name":"directoryDns","value":cdk.Fn.join(',',mad.attrDnsIpAddresses)},
      {"name":"subnetIds", "value": cdk.Fn.join(',',privateSubnets)},
      {"name":"vpcId", "value":vpc.vpcId}
    ]
    
    outputs.forEach((x) => { 
      if (x.value) {
        new cdk.CfnOutput(this, x.name, {value: x.value})
      }
    })
  }
}

const app = new cdk.App();
new AdFsxStack(app, 'AdFsxStack', 'example.corp');
app.synth();