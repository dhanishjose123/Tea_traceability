# Predictive Benchmarking Digital Twin

This folder contains the predictive benchmarking layer for the Tea 9 blockchain digital twin.

Its role is to estimate expected blockchain performance before or during transaction execution using trained Random Forest models.

## Contents

- `models/random_forest_throughput_with_latency.joblib`
- `models/random_forest_failurerate_with_latency.joblib`
- `models/random_forest_metadata.json`
- benchmark data and Caliper experiment files

## Model Inputs

The Random Forest models expect the following six features:

```text
load
hotParticipants
latency
ledgerWrites
reads
payloadBytes
```

## Model Outputs

The models predict:

- transaction throughput
- MVCC failure rate

These predictions can be used to identify high-risk transaction workloads before they are submitted to the blockchain network.

## Current Random Forest Performance

The trained Random Forest models reproduce the manuscript metrics:

| Target | R2 | MAE | RMSE |
|---|---:|---:|---:|
| Throughput | 0.9236 | 11.9332 | 25.1455 |
| Failure Rate | 0.9570 | 0.0368 | 0.0808 |

## Relationship to the RL Scheduler

This folder is the prediction layer. The reinforcement-learning control layer is stored separately in:

```text
../../digital_twin_RL
```

The RL scheduler can use the Random Forest predictions as part of its state and reward calculation, then learn how to throttle, delay, serialize, or prioritize transactions based on observed throughput and failure-rate feedback.

