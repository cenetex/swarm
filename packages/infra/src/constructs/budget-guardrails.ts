/**
 * Budget Guardrails Construct
 *
 * Defines AWS Budget and Cost Anomaly Detection resources for proactive
 * cost governance. Alerts route to the existing ops SNS alarm topic.
 *
 * Resources created:
 * - Monthly AWS Budget with notifications at 50%, 80%, and 100% thresholds
 * - Cost Anomaly Detection monitor (service-level) with SNS subscription
 */
import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface BudgetGuardrailsProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Monthly budget limit in USD.
   * Recommended: staging=$100, prod=$500
   */
  monthlyBudgetUsd: number;

  /**
   * SNS topic to receive budget and anomaly alerts.
   * Typically the shared ops alarm topic.
   */
  alarmTopic: sns.ITopic;

  /**
   * Budget alert thresholds as percentages of the monthly budget.
   * @default [50, 80, 100]
   */
  alertThresholds?: number[];
}

export class BudgetGuardrails extends Construct {
  public readonly budget: budgets.CfnBudget;
  public readonly anomalyMonitor: ce.CfnAnomalyMonitor;
  public readonly anomalySubscription: ce.CfnAnomalySubscription;

  constructor(scope: Construct, id: string, props: BudgetGuardrailsProps) {
    super(scope, id);

    const {
      environment,
      monthlyBudgetUsd,
      alarmTopic,
      alertThresholds = [50, 80, 100],
    } = props;
    const suffix = props.nameSuffix ?? '';

    // ───── Monthly Budget ─────
    // Creates a COST budget that resets monthly and sends SNS notifications
    // when actual spend exceeds configured threshold percentages.
    const notifications: budgets.CfnBudget.NotificationWithSubscribersProperty[] =
      alertThresholds.map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [
          {
            subscriptionType: 'SNS',
            address: alarmTopic.topicArn,
          },
        ],
      }));

    // Add a forecasted 100% threshold so we get early warning if the
    // projected end-of-month spend will exceed the budget.
    notifications.push({
      notification: {
        notificationType: 'FORECASTED',
        comparisonOperator: 'GREATER_THAN',
        threshold: 100,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [
        {
          subscriptionType: 'SNS',
          address: alarmTopic.topicArn,
        },
      ],
    });

    this.budget = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `swarm-monthly-${environment}${suffix}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: monthlyBudgetUsd,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: notifications,
    });

    // ───── Cost Anomaly Detection ─────
    // Monitor at the AWS service level to detect unusual spending patterns
    // across any AWS service used by this account.
    this.anomalyMonitor = new ce.CfnAnomalyMonitor(this, 'AnomalyMonitor', {
      monitorName: `swarm-anomaly-${environment}${suffix}`,
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });

    // Subscribe the ops alarm topic to anomaly alerts.
    // Threshold expression: alert when impact exceeds $10 (absolute) to
    // avoid noise from tiny fluctuations. The thresholdExpression property
    // accepts a JSON string representation of a Cost Explorer expression.
    this.anomalySubscription = new ce.CfnAnomalySubscription(this, 'AnomalySubscription', {
      subscriptionName: `swarm-anomaly-alerts-${environment}${suffix}`,
      monitorArnList: [this.anomalyMonitor.attrMonitorArn],
      subscribers: [
        {
          type: 'SNS',
          address: alarmTopic.topicArn,
        },
      ],
      frequency: 'DAILY',
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: ['10'],
        },
      }),
    });

    // ───── Outputs ─────
    new cdk.CfnOutput(this, 'BudgetName', {
      value: `swarm-monthly-${environment}${suffix}`,
      description: `Monthly budget ($${monthlyBudgetUsd} USD) for ${environment}`,
    });

    new cdk.CfnOutput(this, 'AnomalyMonitorArn', {
      value: this.anomalyMonitor.attrMonitorArn,
      description: `Cost anomaly monitor for ${environment}`,
    });
  }
}
