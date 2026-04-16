# Agents in Oshikatsu Project

This file defines the roles and responsibilities of the agents involved in the development and maintenance of the Oshikatsu project.

## Project Context

The `PROJECT_VISION.md` file serves as the high-level guide, defining the project's core objectives, system capabilities, and long-term roadmap.

The repository also includes two collaboration folders:

- `design_docs/`: Use for planned design and architecture work. Each design document lives in its own dated folder named `[date] - [design summary]`.
- `meeting/`: Use for discussion records. Each meeting or topic discussion should be recorded in its own subfolder with `notes.md`, plus any artifacts and action items.

## Language Guidelines

All documentation, agent instructions, and project artifacts created within this repository must be written in English.

## Agent Roles

### 1. Developer Agent (Primary)

- **Responsibility**: Writing, refactoring, and debugging the core codebase.
- **Focus**: Implementing data collection, processing, and analysis logic.

### 2. Architect Agent

- **Responsibility**: Designing the system architecture and data schemas.
- **Focus**: Creating design documents in `design_docs/`, ensuring scalability and unified data formats.

### 3. QA/Testing Agent

- **Responsibility**: Verifying the correctness of the implementation and the accuracy of the analysis.
- **Focus**: Writing tests and monitoring for system failures.

### 4. DevOps/Automation Agent

- **Responsibility**: Managing the deployment and scheduling of the monitoring tasks.
- **Focus**: Setting up automation and task schedulers.

## Workflow

All agents must follow the established collaboration and design documentation process:

1.  **Discussion**: The user initiates a meeting or topic discussion. Record the discussion in a new subfolder under `meeting/`, including `notes.md`, artifacts, and action items.
2.  **Decision**: After discussion, determine whether a new design document is needed or an existing one should be updated.
3.  **Design**: Create or update a folder in `design_docs/` with the format `[date] - [design summary]`.
4.  **Review**: The user reviews the design doc and approves it before implementation begins.
5.  **Implementation**: Execute the plan only after the design has been reviewed and approved.
6.  **Verification**: Ensure the implementation meets the requirements specified in the approved design doc.
