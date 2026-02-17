/**
 * Utility construct to create or adopt a CloudWatch log group with retention.
 *
 * Background:
 * CDK's `logRetention` Lambda property uses a custom resource to call
 * `CreateLogGroup` + `PutRetentionPolicy` via the CloudWatch Logs API.
 * The log group is NOT modeled as a CloudFormation `AWS::Logs::LogGroup`
 * resource, so CloudFormation doesn't track it.
 *
 * When migrating away from `logRetention` to an explicit `logGroup`,
 * creating an `AWS::Logs::LogGroup` CloudFormation resource with the same
 * name will fail with "Resource already exists" because the orphaned log
 * group from the old custom resource still exists.
 *
 * This construct uses `AwsCustomResource` to:
 * 1. Create the log group if it doesn't exist (idempotent)
 * 2. Set the retention policy
 * 3. Return an `ILogGroup` reference for the Lambda `logGroup` property
 *
 * This is safe for both fresh deployments and migrations from `logRetention`.
 */
import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface LogGroupWithRetentionProps {
  /**
   * The name of the log group (e.g. `/aws/lambda/my-function`).
   */
  logGroupName: string;

  /**
   * Retention period for log events.
   * @default logs.RetentionDays.ONE_MONTH
   */
  retention?: logs.RetentionDays;

  /**
   * Removal policy for the log group.
   * RETAIN means the log group persists after stack deletion.
   * @default cdk.RemovalPolicy.RETAIN
   */
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

    // RetentionDays enum values are the integer days (e.g. ONE_MONTH = 30)
    const retentionDays = retention as number;

    // Use AwsCustomResource to idempotently create-or-adopt the log group
    // and set retention. The CreateLogGroup API is idempotent when the log
    // group already exists (returns ResourceAlreadyExistsException which we
    // ignore). PutRetentionPolicy is always idempotent.
    const createLogGroup = new cr.AwsCustomResource(this, 'CreateLogGroup', {
      resourceType: 'Custom::LogGroupCreate',
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'createLogGroup',
        parameters: {
          logGroupName,
        },
        // Ignore ResourceAlreadyExistsException — log group may already exist
        // from Lambda auto-creation or previous logRetention custom resource
        ignoreErrorCodesMatching: 'ResourceAlreadyExistsException',
        physicalResourceId: cr.PhysicalResourceId.of(`${logGroupName}-create`),
      },
      onUpdate: {
        service: 'CloudWatchLogs',
        action: 'createLogGroup',
        parameters: {
          logGroupName,
        },
        ignoreErrorCodesMatching: 'ResourceAlreadyExistsException',
        physicalResourceId: cr.PhysicalResourceId.of(`${logGroupName}-create`),
      },
      ...(removalPolicy === cdk.RemovalPolicy.DESTROY
        ? {
            onDelete: {
              service: 'CloudWatchLogs',
              action: 'deleteLogGroup',
              parameters: {
                logGroupName,
              },
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

    // Retention must be set after the log group exists
    setRetention.node.addDependency(createLogGroup);

    // Return an ILogGroup reference for the Lambda logGroup property
    this.logGroup = logs.LogGroup.fromLogGroupName(this, 'LogGroupRef', logGroupName);
  }
}
