// Page chrome (top bar) and the two routes.
import { NavLink, Outlet, createBrowserRouter } from "react-router";
import { TaskCreatePage } from "../features/task-create/TaskCreatePage";
import { TaskListPage } from "../features/task-list/TaskListPage";

function App() {
  return (
    <>
      <header className="top-bar">
        <span className="app-name">Task Assignment</span>
        <nav>
          <NavLink to="/" end>
            Tasks
          </NavLink>
          <NavLink to="/tasks/new">New task</NavLink>
        </nav>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <TaskListPage /> },
      { path: "tasks/new", element: <TaskCreatePage /> },
    ],
  },
]);
