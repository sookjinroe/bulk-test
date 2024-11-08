// 전역 변수로 입력 데이터 저장
let inputContents = [];
let batchId = null;
let pollingInterval = null;

// DOM 요소 참조
const inputCsvFile = document.getElementById('input-csv');
const downloadBtn = document.getElementById('download-btn');
const apiKey = document.getElementById('api-key');

// 파일 입력 이벤트 리스너
inputCsvFile.addEventListener('change', handleInputCSV);
downloadBtn.addEventListener('click', startBatchProcess);

// CSV 파일 읽기
async function handleInputCSV(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await readFileAsText(file);
        inputContents = text.split('\n')
            .map(line => line.trim())
            .filter(line => line); // 빈 줄 제거
        
        downloadBtn.disabled = false;
    } catch (error) {
        alert('CSV 파일 읽기 실패: ' + error.message);
    }
}

// Batch 처리 시작
async function startBatchProcess() {
    if (!inputContents.length || !apiKey.value) {
        alert('CSV 파일과 API Key가 필요합니다.');
        return;
    }

    try {
        // 1. JSONL 파일 생성
        const jsonlContent = createBatchJSONL();
        
        // 2. 파일 업로드
        const fileId = await uploadFile(jsonlContent);
        
        // 3. 배치 생성
        batchId = await createBatch(fileId);
        
        // 4. 상태 확인 시작
        startPolling();
        
        downloadBtn.disabled = true;
    } catch (error) {
        alert('배치 처리 시작 실패: ' + error.message);
    }
}

// JSONL 파일 내용 생성
function createBatchJSONL() {
    const requests = inputContents.map((content, index) => ({
        custom_id: `request-${index + 1}`,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
            model: document.getElementById('model').value,
            temperature: parseFloat(document.getElementById('temperature').value) || 0,
            max_tokens: parseInt(document.getElementById('max-tokens').value) || 1000,
            messages: [
                {
                    role: "system",
                    content: document.getElementById('system-message').value
                },
                {
                    role: "user",
                    content: content
                }
            ]
        }
    }));
    
    return requests.map(req => JSON.stringify(req)).join('\n');
}

// 파일 업로드
async function uploadFile(jsonlContent) {
    const formData = new FormData();
    const blob = new Blob([jsonlContent], { type: 'application/jsonl' });
    formData.append('file', blob, 'batch_input.jsonl');
    formData.append('purpose', 'batch');

    const response = await fetch('https://api.openai.com/v1/files', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey.value}`
        },
        body: formData
    });

    if (!response.ok) {
        throw new Error('파일 업로드 실패');
    }

    const data = await response.json();
    return data.id;
}

// 배치 생성
async function createBatch(fileId) {
    const response = await fetch('https://api.openai.com/v1/batches', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey.value}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            input_file_id: fileId,
            endpoint: "/v1/chat/completions",
            completion_window: "24h"
        })
    });

    if (!response.ok) {
        throw new Error('배치 생성 실패');
    }

    const data = await response.json();
    return data.id;
}

// 배치 상태 확인
async function checkBatchStatus() {
    const response = await fetch(`https://api.openai.com/v1/batches/${batchId}`, {
        headers: {
            'Authorization': `Bearer ${apiKey.value}`
        }
    });

    if (!response.ok) {
        throw new Error('상태 확인 실패');
    }

    const data = await response.json();
    
    if (data.status === 'completed') {
        stopPolling();
        const results = await downloadResults(data.output_file_id);
        processBatchResults(results);
    } else if (data.status === 'failed' || data.status === 'expired') {
        stopPolling();
        alert(`배치 처리 실패: ${data.status}`);
    }
}

// 결과 다운로드
async function downloadResults(fileId) {
    const response = await fetch(`https://api.openai.com/v1/files/${fileId}/content`, {
        headers: {
            'Authorization': `Bearer ${apiKey.value}`
        }
    });

    if (!response.ok) {
        throw new Error('결과 다운로드 실패');
    }

    return await response.text();
}

// 배치 결과 처리 및 CSV 다운로드
function processBatchResults(jsonlText) {
    try {
        const results = jsonlText.split('\n')
            .filter(line => line)
            .map(line => JSON.parse(line));
        
        const outputMap = new Map();
        results.forEach(result => {
            if (result.response && result.response.body && 
                result.response.body.choices && 
                result.response.body.choices[0]) {
                const content = result.response.body.choices[0].message.content;
                outputMap.set(result.custom_id, content);
            }
        });

        const csvContent = [
            'Input,Output',
            ...inputContents.map((input, index) => {
                const output = outputMap.get(`request-${index + 1}`) || '';
                return `"${escapeCsvField(input)}","${escapeCsvField(output)}"`;
            })
        ].join('\n');

        downloadCsv(csvContent);
        downloadBtn.disabled = false;
    } catch (error) {
        alert('결과 처리 실패: ' + error.message);
    }
}

// 상태 확인 polling 관련
function startPolling() {
    pollingInterval = setInterval(checkBatchStatus, 5000); // 5초마다 확인
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

// 유틸리티 함수들
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file, 'UTF-8');
    });
}

function escapeCsvField(field) {
    return field.replace(/"/g, '""').replace(/[\n\r]+/g, ' ');
}

function downloadCsv(content) {
    const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'batch_results.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}