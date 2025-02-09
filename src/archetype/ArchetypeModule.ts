// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import * as path from "path";
import * as vscode from "vscode";
import { Uri, workspace } from "vscode";
import { sendInfo } from "vscode-extension-telemetry-wrapper";
import { mavenTerminal } from "../mavenTerminal";
import { Settings } from "../Settings";
import { getPathToExtensionRoot } from "../utils/contextUtils";
import { getEmbeddedMavenWrapper, getMaven } from "../utils/mavenUtils";
import { Utils } from "../utils/Utils";
import { Archetype } from "./Archetype";
import { runSteps, selectArchetypeStep, specifyArchetypeVersionStep, specifyArtifactIdStep, specifyGroupIdStep, specifyTargetFolderStep } from "./createProject";
import { IProjectCreationMetadata, IProjectCreationStep } from "./createProject/types";
const REMOTE_ARCHETYPE_CATALOG_URL: string = "https://repo.maven.apache.org/maven2/archetype-catalog.xml";

export namespace ArchetypeModule {

    export async function createMavenProject(entry: Uri | undefined, _operationId: string): Promise<void> {
        const targetFolder: string | undefined = entry?.fsPath ?? workspace.workspaceFolders?.[0]?.uri.fsPath;
        // default metadata
        const metadata: IProjectCreationMetadata = {
            targetFolder,
            groupId: "com.example",
            artifactId: "demo"
        };
        const steps: IProjectCreationStep[] = [selectArchetypeStep, specifyArchetypeVersionStep, specifyGroupIdStep, specifyArtifactIdStep, specifyTargetFolderStep];
        const success: boolean = await runSteps(steps, metadata);
        if (success) {
            await executeInTerminalHandler(metadata);
        }
    }

    export async function updateArchetypeCatalog(): Promise<void> {
        const xml: string = await Utils.downloadFile(REMOTE_ARCHETYPE_CATALOG_URL, true);
        const archetypes: Archetype[] = await listArchetypeFromXml(xml);
        const targetFilePath: string = path.join(getPathToExtensionRoot(), "resources", "archetypes.json");
        await fse.ensureFile(targetFilePath);
        await fse.writeJSON(targetFilePath, archetypes);
    }

    async function executeInTerminalHandler(metadata: IProjectCreationMetadata): Promise<void> {
        const {
            archetypeArtifactId,
            archetypeGroupId,
            archetypeVersion,
            groupId,
            artifactId,
            targetFolder
        } = metadata;
        if (archetypeArtifactId === undefined || archetypeGroupId === undefined || archetypeVersion === undefined) {
            throw new Error("Archetype information is incomplete.");
        }
        sendInfo("", { archetypeArtifactId, archetypeGroupId, archetypeVersion });
        const cmdArgs: string[] = [
            // explicitly using 3.1.2 as maven-archetype-plugin:3.0.1 ignores -DoutputDirectory
            // see https://github.com/microsoft/vscode-maven/issues/478
            "org.apache.maven.plugins:maven-archetype-plugin:3.1.2:generate",
            `-DarchetypeArtifactId="${archetypeArtifactId}"`,
            `-DarchetypeGroupId="${archetypeGroupId}"`,
            `-DarchetypeVersion="${archetypeVersion}"`,
            `-DgroupId="${groupId}"`,
            `-DartifactId="${artifactId}"`
        ];
        let cwd: string | undefined = targetFolder;
        let mvnPath: string | undefined = await getMaven();
        if (mvnPath === undefined) {
            cmdArgs.push(`-DoutputDirectory="${targetFolder}"`);
            mvnPath = getEmbeddedMavenWrapper();
            cwd = path.dirname(mvnPath);
        }

        if (mvnPath === undefined) { return; }
        const mvnString: string = wrappedWithQuotes(await mavenTerminal.formattedPathForTerminal(mvnPath));

        const defaultArgs: string | undefined = Settings.Executable.options(metadata.targetFolder);
        const mvnSettingsFile: string | undefined = Settings.getSettingsFilePath();
        const mvnSettingsArg: string | undefined = mvnSettingsFile ? `-s "${await mavenTerminal.formattedPathForTerminal(mvnSettingsFile)}"` : undefined;
        let commandLine: string = [mvnString, ...cmdArgs, defaultArgs, mvnSettingsArg].filter(Boolean).join(" ");
        const options: vscode.ShellExecutionOptions = { cwd };
        if (vscode.env.remoteName === undefined && process.platform === "win32") { // VS Code launched in Windows Desktop.
            options.shellQuoting = shellQuotes.cmd;
            options.executable = "cmd.exe";
            options.shellArgs = ["/c"];
            commandLine = `"${commandLine}"`; // wrap full command with quotation marks, cmd /c "<fullcommand>", see https://stackoverflow.com/a/6378038
        } else {
            options.shellQuoting = shellQuotes.bash;
        }
        const execution = new vscode.ShellExecution(commandLine, options);
        const createProjectTask = new vscode.Task({ type: "maven", targetFolder, artifactId }, vscode.TaskScope.Global, "createProject", "maven", execution);
        vscode.tasks.executeTask(createProjectTask);
    }

    export async function listArchetypeFromXml(xmlString: string): Promise<Archetype[]> {
        try {
            const xmlObject: any = await Utils.parseXmlContent(xmlString);
            const catalog: any = xmlObject && xmlObject["archetype-catalog"];
            const dict: { [key: string]: Archetype } = {};
            const archetypeList: any[] = catalog.archetypes[0].archetype;
            archetypeList.forEach(archetype => {
                const groupId: string = archetype.groupId && archetype.groupId[0];
                const artifactId: string = archetype.artifactId && archetype.artifactId[0];
                const description: string = archetype.description && archetype.description[0];
                const version: string = archetype.version && archetype.version[0];
                const repository: string = archetype.repository && archetype.repository[0];
                const identifier: string = `${groupId}:${artifactId}`;

                if (dict[identifier] === undefined) {
                    dict[identifier] = new Archetype(artifactId, groupId, repository, description);
                }
                if (dict[identifier].versions.indexOf(version) < 0) {
                    dict[identifier].versions.push(version);
                }
            });
            return Object.keys(dict).map((k: string) => dict[k]);

        } catch (err) {
            console.error(err);
        }
        return [];
    }
}

export class ArchetypeMetadata {
    public groupId: string;
    public artifactId: string;
    public versions: string[];
    public version: string;
    public isLoadMore: boolean;
}

function wrappedWithQuotes(mvn: string): string {
    if (mvn === "mvn") {
        return mvn;
    } else {
        return `"${mvn}"`;
    }
}

// see https://github.com/microsoft/vscode/blob/dddbfa61652de902c75436d250a50c71501da2d7/src/vs/workbench/contrib/tasks/browser/terminalTaskSystem.ts#L140
const shellQuotes: { [key: string]: vscode.ShellQuotingOptions } = {
    cmd: {
        strong: "\""
    },
    powershell: {
        escape: {
            escapeChar: "`",
            charsToEscape: " \"'()"
        },
        strong: "'",
        weak: "\""
    },
    bash: {
        escape: {
            escapeChar: "\\",
            charsToEscape: " \"'"
        },
        strong: "'",
        weak: "\""
    },
    zsh: {
        escape: {
            escapeChar: "\\",
            charsToEscape: " \"'"
        },
        strong: "'",
        weak: "\""
    }
};
