#!/usr/bin/env node
/* eslint no-await-in-loop: 0 */

let axios = require('axios')
  , extract = require('extract-zip')
  , { retry } = require('async')
  , { createWriteStream } = require('fs')
  , { mkdir, rm, readdir } = require('fs/promises')
  , { join } = require('path')
  , notionAPI = 'https://www.notion.so/api/v3'
  , { NOTION_TOKEN, NOTION_FILE_TOKEN, NOTION_SPACE_ID } = process.env
  , { NOTION_USER_ID, NOTION_DATABASE_ID } = process.env
  , client = axios.create({
      baseURL: notionAPI,
      headers: {
        Cookie: `token_v2=${NOTION_TOKEN}; file_token=${NOTION_FILE_TOKEN}`,
        'x-notion-active-user-header': `${NOTION_USER_ID}`,
        'x-notion-space-id': `${NOTION_SPACE_ID}`
      },
    })
  , die = (str) => {
      console.error(str);
      process.exit(1);
    }
;

if (!NOTION_TOKEN || !NOTION_FILE_TOKEN || !NOTION_SPACE_ID) {
  die(`Need to have NOTION_TOKEN, NOTION_FILE_TOKEN and NOTION_SPACE_ID defined in the environment.
See https://github.com/darobin/notion-backup/blob/main/README.md for
a manual on how to get that information.`);
}

async function post (endpoint, data) {
  return client.post(endpoint, data);
}

async function sleep (seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}


// formats: markdown, html
async function exportFromNotion (format) {
  try {
    let { data: { taskId } } = await post('enqueueTask', {
      task: {
        eventName: 'exportSpace',
        request: {
          spaceId: `${NOTION_SPACE_ID}`,
          recursive: true,
          exportOptions: {
            exportType: format,
            timeZone: 'Asia/Shanghai',
            locale: 'en',
            collectionViewExportType: 'currentView',
            includeContents: 'everything',
            preferredViewMap: {
            }
          },
          shouldExportComments: false,
        },
        cellRouting: {
          spaceIds: [
          ]
        }
      },
    });
    console.warn(`Enqueued task ${taskId}`);

    let failCount = 0
      , exportURL
      , hasSuccessed = false
    ;
    // 创建任务
    while (true) {
      if (failCount >= 5) break;
      let sleepS = 35
      if(failCount>2){
        sleepS = 20
      }
      await sleep(sleepS);
      let { data: { results: tasks } } = await retry(
        { times: 3, interval: 2000 },
        async () => post('getTasks', { taskIds: [taskId] })
      );
      let task = tasks.find(t => t.id === taskId);
      // console.warn(JSON.stringify(task, null, 2)); // DBG
      if (!task) {
        failCount++;
        console.warn(`No task, waiting.`);
        continue;
      }
      if (task.state === 'success') {
        hasSuccessed = true;
        break;
      }
    }

    if (!hasSuccessed) {
      console.warn('No Download link');
      return;
    }

    failCount = 0;
    // 获取消息通知里面的下载链接
    while (true) {
      console.warn('Waiting for export to complete...');
      if (failCount >= 5) break;
      await sleep(20);

      let response = await retry(
        { times: 2, interval: 5000 },
        async () => post('getNotificationLog', { spaceId: `${NOTION_SPACE_ID}`, size: 1, type: 'unread_and_read' })
      );

      console.warn('数据获取成功', JSON.stringify(response.data));

      let { activity } = response.data.recordMap;

      console.warn('activity->', JSON.stringify(activity));

      // eslint-disable-next-line guard-for-in
      for (const key in activity) {
        const el = activity[key];
        console.warn('el.value->', JSON.stringify(el.value));
          if (el.value.type === 'export-completed') {
            console.warn('el.value.type->', el.value.type);
            let { edits } = el.value;
            // eslint-disable-next-line guard-for-in
            for (const k in edits) {
              const it = edits[k];
              if (it.type === 'export-completed') {
                exportURL = it.link;
                // 判断链接是否过期
                const timestamp = exportURL.split('expirationTimestamp=')[1].split('&')[0];
                console.warn('expirationTimestamp：', timestamp); // 输出：1767959286376
                const curr = Date.now();
                if (Number(timestamp) <= curr) {
                  console.warn('链接过期了，waiting...');
                  exportURL = null;
                  continue;
                } else {
                  break;
                }
              }
            }

            if (exportURL) {
              console.warn(`获取链接成功：${exportURL}`);
              break;
            } else {
              console.warn(`未找到正确链接，继续for循环`);
              continue;
            }
          }
      }

      if (!exportURL) {
        failCount++;
        console.warn(`No link, waiting.`);
        continue;
      }

      const timestamp = exportURL.split('expirationTimestamp=')[1].split('&')[0];
      console.warn('expirationTimestamp：', timestamp); // 输出：1767959286376
      const curr = Date.now();
      if (Number(timestamp) < curr) {
        failCount++;
        console.warn('链接过期了，waiting...');
        continue;
      } else {
        break;
      }
    }

    if (!exportURL) {
      throw new Error('最终未找到正确的链接');
    }


    let res = await client({
      method: 'GET',
      url: exportURL,
      responseType: 'stream'
    });
    let stream = res.data.pipe(createWriteStream(join(process.cwd(), `${format}.zip`)));
    await new Promise((resolve, reject) => {
      stream.on('close', resolve);
      stream.on('error', reject);
    });
  }
  catch (err) {
    die(err);
  }
}

async function run () {
  let cwd = process.cwd()
    , mdDir = join(cwd, 'markdown')
    , mdFile = join(cwd, 'markdown.zip')
    , htmlDir = join(cwd, 'html')
    , htmlFile = join(cwd, 'html.zip')
  ;
  await exportFromNotion('markdown');
  await rm(mdDir, { recursive: true, force: true });
  await mkdir(mdDir, { recursive: true });
  await extract(mdFile, { dir: mdDir });
  await extractInnerZip(mdDir);
  await exportFromNotion('html');
  await rm(htmlDir, { recursive: true, force: true });
  await mkdir(htmlDir, { recursive: true });
  await extract(htmlFile, { dir: htmlDir });
  await extractInnerZip(htmlDir);
}

async function extractInnerZip (dir) {
  let files = (await readdir(dir)).filter(fn => /Part-\d+\.zip$/i.test(fn));
  for (let file of files) {
    await extract(join(dir, file), { dir });
  }
}

run();
