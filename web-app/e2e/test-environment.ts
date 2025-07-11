import { Browser, chromium, Page } from '@playwright/test';
import * as fs from 'fs';
import { GenericContainer, Network, StartedTestContainer, Wait } from 'testcontainers';

export interface TestEnvironment {
  paperlessNgx: StartedTestContainer;
  paperlessGpt: StartedTestContainer;
  browser: Browser;
  cleanup: () => Promise<void>;
}

export const PORTS = {
  paperlessNgx: 8000,
  paperlessGpt: 8080,
};

export const PREDEFINED_TAGS = [
  'paperless-gpt',
  'paperless-gpt-ocr-auto',
  'paperless-gpt-ocr-complete',
]

export interface TestEnvironmentConfig {
  ocrProvider?: string;
  processMode?: string;
}

export async function setupTestEnvironment(config?: TestEnvironmentConfig): Promise<TestEnvironment> {
  console.log('Setting up test environment...');
  const paperlessPort = PORTS.paperlessNgx;
  const gptPort = PORTS.paperlessGpt;

  // Create a network for the containers
  const network = await new Network().start();

  console.log('Starting Redis container...');
  const redis = await new GenericContainer('redis:7')
    .withNetwork(network)
    .withNetworkAliases('redis')
    .start();

  console.log('Starting Postgres container...');
  const postgres = await new GenericContainer('postgres:15')
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .withEnvironment({
      POSTGRES_DB: 'paperless',
      POSTGRES_USER: 'paperless',
      POSTGRES_PASSWORD: 'paperless'
    })
    .start();

  console.log('Starting Paperless-ngx container...');
  const paperlessNgx = await new GenericContainer('ghcr.io/paperless-ngx/paperless-ngx:latest')
    .withNetwork(network)
    .withNetworkAliases('paperless-ngx')
    .withEnvironment({
      PAPERLESS_URL: `http://localhost:${paperlessPort}`,
      PAPERLESS_SECRET_KEY: 'change-me',
      PAPERLESS_ADMIN_USER: 'admin',
      PAPERLESS_ADMIN_PASSWORD: 'admin',
      PAPERLESS_TIME_ZONE: 'Europe/Berlin',
      PAPERLESS_OCR_LANGUAGE: 'eng',
      PAPERLESS_REDIS: 'redis://redis:6379',
      PAPERLESS_DBHOST: 'postgres',
      PAPERLESS_DBNAME: 'paperless',
      PAPERLESS_DBUSER: 'paperless',
      PAPERLESS_DBPASS: 'paperless'
    })
    .withExposedPorts(paperlessPort)
    .withWaitStrategy(Wait.forHttp('/api/', paperlessPort))
    .start();

  const mappedPort = paperlessNgx.getMappedPort(paperlessPort);
  console.log(`Paperless-ngx container started, mapped port: ${mappedPort}`);
  // Create required tag before starting paperless-gpt
  const baseUrl = `http://localhost:${mappedPort}`;
  const credentials = { username: 'admin', password: 'admin' };

  try {
    console.log('Creating predefined tags...');
    // Create predefined tags
    for (const tag of PREDEFINED_TAGS) {
      await createTag(baseUrl, tag, credentials);
    }
  } catch (error) {
    console.error('Failed to create tag:', error);
    await paperlessNgx.stop();
    throw error;
  }

  console.log('Starting Paperless-gpt container...');
  const paperlessGptImage = process.env.PAPERLESS_GPT_IMAGE || 'icereed/paperless-gpt:e2e';
  console.log(`Using image: ${paperlessGptImage}`);

  // Build environment configuration based on provided config
  const baseEnvironment = {
    PAPERLESS_BASE_URL: `http://paperless-ngx:${paperlessPort}`,
    PAPERLESS_API_TOKEN: await getApiToken(baseUrl, credentials),
    LLM_PROVIDER: "openai",
    LLM_MODEL: "gpt-4o-mini",
    LLM_LANGUAGE: "english",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    PDF_OCR_TAGGING: "true",
    PDF_OCR_COMPLETE_TAG: "paperless-gpt-ocr-complete",
  };

  // Configure OCR provider and processing mode based on config
  if (config?.ocrProvider === 'mistral_ocr') {
    Object.assign(baseEnvironment, {
      OCR_PROVIDER: "mistral_ocr",
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
      MISTRAL_MODEL: "mistral-ocr-latest",
      OCR_PROCESS_MODE: config.processMode || "whole_pdf",
    });
    console.log('Configured for Mistral OCR with process mode:', config.processMode || "whole_pdf");
  } else {
    // Default LLM OCR configuration
    Object.assign(baseEnvironment, {
      OCR_PROVIDER: "llm",
      VISION_LLM_PROVIDER: "openai",
      VISION_LLM_MODEL: "gpt-4o-mini",
      OCR_PROCESS_MODE: config?.processMode || "image",
    });
    console.log('Configured for LLM OCR with process mode:', config?.processMode || "image");
  }

  const paperlessGpt = await new GenericContainer(paperlessGptImage)
    .withNetwork(network)
    .withEnvironment(baseEnvironment)
    .withExposedPorts(gptPort)
    .withWaitStrategy(Wait.forHttp('/', gptPort))
    .start();
  console.log('Paperless-gpt container started');

  console.log('Launching browser...');
  const browser = await chromium.launch();
  console.log('Browser launched');

  const cleanup = async () => {
    console.log('Cleaning up test environment...');
    await browser.close();
    await paperlessGpt.stop();
    await paperlessNgx.stop();
    await redis.stop();
    await postgres.stop();
    await network.stop();
    console.log('Test environment cleanup completed');
  };

  console.log('Test environment setup completed');
  return {
    paperlessNgx,
    paperlessGpt,
    browser,
    cleanup,
  };
}

export async function waitForElement(page: Page, selector: string, timeout = 5000): Promise<void> {
  await page.waitForSelector(selector, { timeout });
}

export interface PaperlessDocument {
  id: number;
  title: string;
  content: string;
  tags: number[];
}

// Helper to upload a document via Paperless-ngx API
export async function uploadDocument(
  baseUrl: string,
  filePath: string,
  title: string,
  credentials: { username: string; password: string }
): Promise<PaperlessDocument> {
  console.log(`Uploading document: ${title} from ${filePath}`);
  const formData = new FormData();
  const fileData = await fs.promises.readFile(filePath);
  formData.append('document', new Blob([fileData]));
  formData.append('title', title);

  // Initial upload to get task ID
  const uploadResponse = await fetch(`${baseUrl}/api/documents/post_document/`, {
    method: 'POST',
    body: formData,
    headers: {
      'Authorization': 'Basic ' + btoa(`${credentials.username}:${credentials.password}`),
    },
  });

  if (!uploadResponse.ok) {
    console.error(`Upload failed with status ${uploadResponse.status}: ${uploadResponse.statusText}`);
    throw new Error(`Failed to upload document: ${uploadResponse.statusText}`);
  }
  
  const task_id = await uploadResponse.json();
  
  // Poll the tasks endpoint until document is processed
  while (true) {
    console.log(`Checking task status for ID: ${task_id}`);
    const taskResponse = await fetch(`${baseUrl}/api/tasks/?task_id=${task_id}`, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${credentials.username}:${credentials.password}`),
      },
    });

    if (!taskResponse.ok) {
      throw new Error(`Failed to check task status: ${taskResponse.statusText}`);
    }

    const taskResultArr = await taskResponse.json();
    console.log(`Task status: ${JSON.stringify(taskResultArr)}`);

    if (taskResultArr.length === 0) {
      continue;
    }
    const taskResult = taskResultArr[0];
    // Check if task is completed
    if (taskResult.status === 'SUCCESS' && taskResult.id) {
      console.log(`Document processed successfully with ID: ${taskResult.id}`);
      
      // Fetch the complete document details
      const documentResponse = await fetch(`${baseUrl}/api/documents/${taskResult.id}/`, {
        headers: {
          'Authorization': 'Basic ' + btoa(`${credentials.username}:${credentials.password}`),
        },
      });

      if (!documentResponse.ok) {
        throw new Error(`Failed to fetch document details: ${documentResponse.statusText}`);
      }

      return await documentResponse.json();
    }
    
    // Check for failure
    if (taskResult.status === 'FAILED') {
      throw new Error(`Document processing failed: ${taskResult.result}`);
    }
    
    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
// Helper to create a tag via Paperless-ngx API
export async function createTag(
  baseUrl: string,
  name: string,
  credentials: { username: string; password: string }
): Promise<number> {
  console.log(`Creating tag: ${name}`);
  
  // First check if the tag already exists
  const existingTagId = await getTagByName(baseUrl, name, credentials);
  if (existingTagId !== null) {
    console.log(`Tag "${name}" already exists with ID: ${existingTagId}`);
    return existingTagId;
  }
  
  // Create new tag if it doesn't exist
  const response = await fetch(`${baseUrl}/api/tags/`, {
    method: 'POST',
    body: JSON.stringify({ name }),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`${credentials.username}:${credentials.password}`),
    },
  });

  if (!response.ok) {
    console.error(`Tag creation failed with status ${response.status}: ${response.statusText}`);
    throw new Error(`Failed to create tag: ${response.statusText}`);
  }

  const tag = await response.json();
  console.log(`Tag created successfully with ID: ${tag.id}`);
  return tag.id;
}

// Helper to get an API token
export async function getApiToken(
  baseUrl: string,
  credentials: { username: string; password: string }
): Promise<string> {
  console.log('Fetching API token');
  const response = await fetch(`${baseUrl}/api/token/`, {
    method: 'POST',
    body: new URLSearchParams({
      username: credentials.username,
      password: credentials.password,
    }),
  });

  if (!response.ok) {
    console.error(`API token fetch failed with status ${response.status}: ${response.statusText}`);
    throw new Error(`Failed to fetch API token: ${response.statusText}`);
  }

  const token = await response.json();
  console.log(`API token fetched successfully: ${token.token}`);
  return token.token;
}

// Helper to get a tag by name
export async function getTagByName(
  baseUrl: string,
  name: string,
  credentials: { username: string; password: string }
): Promise<number | null> {
  console.log(`Getting tag by name: ${name}`);
  const response = await fetch(`${baseUrl}/api/tags/?name=${encodeURIComponent(name)}`, {
    headers: {
      'Authorization': 'Basic ' + btoa(`${credentials.username}:${credentials.password}`),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch tag: ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.results || data.results.length === 0) {
    return null;
  }

// iterate through all tags and find the one with the correct name
  const tag = data.results.find((tag: { name: string }) => tag.name === name);
  if (!tag) {
    console.error(`Tag "${name}" not found`);
    return null;
  }

  console.log(`Tag found with ID: ${tag.id}`);
  return tag.id;
}

// Helper to add a tag to a document
export async function addTagToDocument(
  baseUrl: string,
  documentId: number,
  tagId: number,
  credentials: { username: string; password: string }
): Promise<void> {
  console.log(`Adding tag ${tagId} to document ${documentId}`);
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/`, {
    method: 'PATCH',
    body: JSON.stringify({
      tags: [tagId],
    }),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`${credentials.username}:${credentials.password}`),
    },
  });

  if (!response.ok) {
    console.error(`Tag addition failed with status ${response.status}: ${response.statusText}`);
    throw new Error(`Failed to add tag to document: ${response.statusText}`);
  }
  console.log('Tag added successfully');
}
