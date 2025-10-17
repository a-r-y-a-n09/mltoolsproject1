require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const OpenAI = require('openai');
const simpleGit = require('simple-git');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Main endpoint to receive build requests
app.post('/api/build', async (req, res) => {
  try {
    const { email, secret, task, round, nonce, brief, checks, evaluation_url, attachments } = req.body;

    // Verify secret
    if (secret !== process.env.SECRET_KEY) {
      return res.status(403).json({ error: 'Invalid secret' });
    }

    // Send 200 response immediately
    res.status(200).json({ message: 'Request received, processing...' });

    // Process in background
    processRequest({ email, task, round, nonce, brief, checks, evaluation_url, attachments });
  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

async function processRequest(data) {
  try {
    const { email, task, round, nonce, brief, checks, evaluation_url, attachments } = data;

    // Step 1: Generate code using LLM
    const code = await generateCode(brief, attachments, checks);

    // Step 2: Create GitHub repo
    const repoName = `${task}-round${round}`;
    const repo = await createGitHubRepo(repoName, code);

    // Step 3: Enable GitHub Pages
    await enableGitHubPages(repo.owner.login, repoName);

    // Step 4: Wait for Pages to deploy
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds

    // Step 5: Notify evaluation API
    const pagesUrl = `https://${repo.owner.login}.github.io/${repoName}/`;
    await notifyEvaluation({
      email,
      task,
      round,
      nonce,
      repo_url: repo.html_url,
      commit_sha: repo.default_branch,
      pages_url: pagesUrl
    }, evaluation_url);

    console.log('Successfully processed request for task:', task);
  } catch (error) {
    console.error('Error processing request:', error);
  }
}

async function generateCode(brief, attachments, checks) {
  const prompt = `Create a complete, production-ready single-page web application based on this brief:

${brief}

Requirements:
${checks.map((check, i) => `${i + 1}. ${check}`).join('\n')}

${attachments && attachments.length > 0 ? `Attachments provided:\n${attachments.map(a => `- ${a.name}`).join('\n')}` : ''}

Generate a complete HTML file with inline CSS and JavaScript. The app should:
- Be a single index.html file
- Work standalone without external dependencies except CDN libraries
- Include proper error handling
- Be mobile-responsive
- Have clean, professional styling

Return ONLY the HTML code, nothing else.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
  });

  let htmlContent = response.choices[0].message.content;
  
  // Clean up markdown code blocks if present
  htmlContent = htmlContent.replace(/```html\n?/g, '').replace(/```\n?/g, '');

  // Embed attachments as data URIs in the code if needed
  if (attachments && attachments.length > 0) {
    attachments.forEach(attachment => {
      // The attachment.url is already a data URI
      // You might need to replace placeholders in the generated code
    });
  }

  return {
    'index.html': htmlContent,
    'README.md': generateReadme(brief, checks),
    'LICENSE': getMITLicense()
  };
}

async function createGitHubRepo(repoName, files) {
  const username = (await octokit.users.getAuthenticated()).data.login;

  // Create repo
  const repo = await octokit.repos.createForAuthenticatedUser({
    name: repoName,
    auto_init: true,
    private: false,
  });

  // Wait for repo to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Create files
  for (const [filename, content] of Object.entries(files)) {
    await octokit.repos.createOrUpdateFileContents({
      owner: username,
      repo: repoName,
      path: filename,
      message: `Add ${filename}`,
      content: Buffer.from(content).toString('base64'),
    });
  }

  return repo.data;
}

async function enableGitHubPages(owner, repo) {
  try {
    await octokit.repos.createPagesSite({
      owner,
      repo,
      source: {
        branch: 'main',
        path: '/'
      }
    });
  } catch (error) {
    if (error.status !== 409) { // 409 means already exists
      throw error;
    }
  }
}

async function notifyEvaluation(data, evaluation_url) {
  const maxRetries = 5;
  let delay = 1000; // Start with 1 second

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.post(evaluation_url, data, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      if (response.status === 200) {
        console.log('Successfully notified evaluation API');
        return;
      }
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      }
    }
  }

  throw new Error('Failed to notify evaluation API after retries');
}

function generateReadme(brief, checks) {
  return `# Project Application

## Summary
${brief}

## Setup
1. Clone this repository
2. Open index.html in a web browser

## Usage
Open the deployed GitHub Pages URL or run locally by opening index.html.

## Features
${checks.map((check, i) => `${i + 1}. ${check}`).join('\n')}

## Code Explanation
This is a single-page application built with vanilla HTML, CSS, and JavaScript. It uses modern web APIs and follows best practices for:
- Responsive design
- Error handling
- User experience
- Code organization

## License
MIT License - see LICENSE file for details
`;
}

function getMITLicense() {
  const year = new Date().getFullYear();
  return `MIT License

Copyright (c) ${year}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/api/build`);
});
