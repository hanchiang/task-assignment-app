import type { TaskNode } from "../../api/types";
import { TaskRow } from "./TaskRow";
import type { TaskListContext } from "./taskListContext";

type Props = { tasks: TaskNode[]; context: TaskListContext };

export function TaskTable({ tasks, context }: Props) {
  return (
    <div className="table-scroll">
      <table className="task-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Skills</th>
            <th>Status</th>
            <th>Assignee</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} context={context} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
