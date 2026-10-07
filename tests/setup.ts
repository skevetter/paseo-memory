import { afterAll } from "bun:test";
import { removeTempDirs } from "./helpers";

afterAll(removeTempDirs);
