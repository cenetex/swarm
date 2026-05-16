/**
 * Utility construct to create or adopt a CloudWatch log group with retention.
 *
 * This avoids CloudFormation "already exists" errors for Lambda log groups
 * that may have been created by the Lambda runtime or older log-retention
 * custom resources before they were explicitly managed by the stack.
 */
import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface LogGroupWithRetentionProps {
  logGroupName: string;
  retention?: logs.RetentionDays;
  removalPolicy?: cdk.RemovalPolicy;
}

export class LogGroupWithRetention extends Construct {
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: LogGroupWithRetentionProps) {
    super(scope, id);

    const {
      logGroupName,
      retention = logs.RetentionDays.ONE_MONTH,
      removalPolicy = cdk.RemovalPolicy.RETAIN,
    } = props;
    const retentionDays = retention as number;

    const createLogGroup = new cr.AwsCustomResource(this, 'CreateLogGroup', {
      resourceType: 'Custom::LogGroupCreate',
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'createLogGroup',
        parameters: { logGroupName },
        ignoreErrorCodesMatching: 'ResourceAlreadyExistsException',
        physicalResourceId: cr.PhysicalResourceId.of(`${logGroupName}-create`),
      },
      onUpdate: {
        service: 'CloudWatchLogs',
        action: 'createLogGroup',
        parameters: { logGroupName },
        ignoreErrorCodesMatching: 'ResourceAlreadyExistsException',
        physicalResourceId: cr.PhysicalResourceId.of(`${logGroupName}-create`),
      },
      ...(removalPolicy === cdk.RemovalPolicy.DESTROY
        ? {
            onDelete: {
              service: 'CloudWatchLogs',
              action: 'deleteLogGroup',
              parameters: { logGroupName },
              ignoreErrorCodesMatching: 'ResourceNotFoundException',
            },
          }
        : {}),
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['logs:CreateLogGroup', 'logs:DeleteLogGroup'],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'logs',
              resource: 'log-group',
              resourceName: `${logGroupName}:*`,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      ]),
    });

    const setRetention = new cr.AwsCustomResource(this, 'SetRetention', {
      resourceType: 'Custom::LogGroupRetention',
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'putRetentionPolicy',
        parameters: {
          logGroupName,
          retentionInDays: retentionDays,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${logGroupName}-retention`),
      },
      onUpdate: {
        service: 'CloudWatchLogs',
        action: 'putRetentionPolicy',
        parameters: {
          logGroupName,
          retentionInDays: retentionDays,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${logGroupName}-retention`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy'],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'logs',
              resource: 'log-group',
              resourceName: `${logGroupName}:*`,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      ]),
    });

    setRetention.node.addDependency(createLogGroup);
    this.logGroup = logs.LogGroup.fromLogGroupName(this, 'LogGroupRef', logGroupName);
  }
}
