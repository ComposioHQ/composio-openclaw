import { Composio } from "@composio/core";
import type {
  ComposioConfig,
  ToolSearchResult,
  ToolExecutionResult,
  MultiExecutionItem,
  MultiExecutionResult,
  ConnectionStatus,
} from "./types.js";

/**
 * Composio client wrapper for Clawdbot integration
 */
export class ComposioClient {
  private client: Composio;
  private config: ComposioConfig;

  constructor(config: ComposioConfig) {
    if (!config.apiKey) {
      throw new Error(
        "Composio API key required. Set COMPOSIO_API_KEY env var or plugins.composio.apiKey in config."
      );
    }
    this.config = config;
    this.client = new Composio({ apiKey: config.apiKey });
  }

  /**
   * Get the user ID to use for API calls
   */
  private getUserId(overrideUserId?: string): string {
    return overrideUserId || this.config.defaultUserId || "default";
  }

  /**
   * Check if a toolkit is allowed based on config
   */
  private isToolkitAllowed(toolkit: string): boolean {
    const { allowedToolkits, blockedToolkits } = this.config;

    if (blockedToolkits?.includes(toolkit.toLowerCase())) {
      return false;
    }

    if (allowedToolkits && allowedToolkits.length > 0) {
      return allowedToolkits.includes(toolkit.toLowerCase());
    }

    return true;
  }

  /**
   * Search for tools matching a query
   */
  async searchTools(
    query: string,
    options?: {
      toolkits?: string[];
      limit?: number;
      userId?: string;
    }
  ): Promise<ToolSearchResult[]> {
    const userId = this.getUserId(options?.userId);
    const limit = options?.limit ?? 10;

    try {
      // Filter toolkits based on config
      let toolkits = options?.toolkits;
      if (toolkits) {
        toolkits = toolkits.filter((t) => this.isToolkitAllowed(t));
      }

      const tools = await this.client.tools.get(userId, {
        ...(toolkits && toolkits.length > 0 ? { toolkits } : {}),
      });

      // Filter and map results
      const results: ToolSearchResult[] = [];
      for (const tool of tools) {
        if (!this.isToolkitAllowed(tool.appName || "")) continue;

        // Simple query matching on name and description
        const searchText = `${tool.name} ${tool.description}`.toLowerCase();
        if (query && !searchText.includes(query.toLowerCase())) continue;

        results.push({
          name: tool.name,
          slug: tool.name, // Composio uses name as slug
          description: tool.description || "",
          toolkit: tool.appName || "",
          parameters: tool.parameters || {},
        });

        if (results.length >= limit) break;
      }

      return results;
    } catch (err) {
      throw new Error(
        `Failed to search tools: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Execute a single tool
   */
  async executeTool(
    toolSlug: string,
    args: Record<string, unknown>,
    userId?: string
  ): Promise<ToolExecutionResult> {
    const uid = this.getUserId(userId);

    try {
      // Extract toolkit from tool slug (format: TOOLKIT_ACTION)
      const toolkit = toolSlug.split("_")[0]?.toLowerCase() || "";
      if (!this.isToolkitAllowed(toolkit)) {
        return {
          success: false,
          error: `Toolkit '${toolkit}' is not allowed by plugin configuration`,
        };
      }

      const result = await this.client.tools.execute(uid, toolSlug, args);

      return {
        success: true,
        data: result,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute multiple tools in parallel
   */
  async multiExecute(
    executions: MultiExecutionItem[],
    userId?: string
  ): Promise<MultiExecutionResult> {
    const uid = this.getUserId(userId);

    // Limit to 50 executions
    const limitedExecutions = executions.slice(0, 50);

    const results = await Promise.all(
      limitedExecutions.map(async (exec) => {
        const result = await this.executeTool(exec.tool_slug, exec.arguments, uid);
        return {
          tool_slug: exec.tool_slug,
          ...result,
        };
      })
    );

    return { results };
  }

  /**
   * Get connection status for toolkits
   */
  async getConnectionStatus(
    toolkits?: string[],
    userId?: string
  ): Promise<ConnectionStatus[]> {
    const uid = this.getUserId(userId);

    try {
      const connections = await this.client.connectedAccounts.list({
        userId: uid,
      });

      const statuses: ConnectionStatus[] = [];
      const connectedToolkits = new Set(
        connections.map((c: { appName?: string }) => c.appName?.toLowerCase())
      );

      // If specific toolkits requested, check those
      if (toolkits && toolkits.length > 0) {
        for (const toolkit of toolkits) {
          if (!this.isToolkitAllowed(toolkit)) continue;
          statuses.push({
            toolkit,
            connected: connectedToolkits.has(toolkit.toLowerCase()),
            userId: uid,
          });
        }
      } else {
        // Return all connected toolkits
        for (const conn of connections) {
          const toolkit = conn.appName || "";
          if (!this.isToolkitAllowed(toolkit)) continue;
          statuses.push({
            toolkit,
            connected: true,
            userId: uid,
          });
        }
      }

      return statuses;
    } catch (err) {
      throw new Error(
        `Failed to get connection status: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Create an auth connection for a toolkit
   */
  async createConnection(
    toolkit: string,
    userId?: string
  ): Promise<{ authUrl: string } | { error: string }> {
    const uid = this.getUserId(userId);

    if (!this.isToolkitAllowed(toolkit)) {
      return { error: `Toolkit '${toolkit}' is not allowed by plugin configuration` };
    }

    try {
      const authConfig = await this.client.authConfigs.create({
        appName: toolkit.toUpperCase(),
        useComposioManagedAuth: true,
      });

      const connection = await this.client.connectedAccounts.initiate({
        authConfigId: authConfig.id,
        userId: uid,
      });

      return { authUrl: connection.connectionUrl || "" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * List available toolkits
   */
  async listToolkits(): Promise<string[]> {
    try {
      const apps = await this.client.apps.list();
      return apps
        .map((app: { name?: string }) => app.name || "")
        .filter((name: string) => name && this.isToolkitAllowed(name));
    } catch (err) {
      throw new Error(
        `Failed to list toolkits: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Disconnect a toolkit
   */
  async disconnectToolkit(
    toolkit: string,
    userId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const uid = this.getUserId(userId);

    try {
      const connections = await this.client.connectedAccounts.list({
        userId: uid,
      });

      const conn = connections.find(
        (c: { appName?: string }) => c.appName?.toLowerCase() === toolkit.toLowerCase()
      );

      if (!conn) {
        return { success: false, error: `No connection found for toolkit '${toolkit}'` };
      }

      await this.client.connectedAccounts.delete({ connectedAccountId: conn.id });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Create a Composio client instance
 */
export function createComposioClient(config: ComposioConfig): ComposioClient {
  return new ComposioClient(config);
}
