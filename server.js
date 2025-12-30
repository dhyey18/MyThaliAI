const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.get('/list-models', (req, res) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
  
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => { data += chunk; });
    apiRes.on('end', () => {
      try {
        const jsonData = JSON.parse(data);
        const visionModels = jsonData.models?.filter(m => 
          m.supportedGenerationMethods?.includes('generateContent') &&
          (m.name.includes('vision') || m.name.includes('flash') || m.name.includes('pro'))
        ) || [];
        res.json({ 
          allModels: jsonData.models?.map(m => ({
            name: m.name,
            displayName: m.displayName,
            supportedMethods: m.supportedGenerationMethods
          })) || [],
          visionModels: visionModels.map(m => m.name),
          suggestion: 'Try using one of the vision models listed above'
        });
      } catch (error) {
        res.status(500).json({ 
          status: 'error', 
          message: error.message,
          rawResponse: data
        });
      }
    });
  }).on('error', (error) => {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      suggestion: 'Check your GEMINI_API_KEY in .env file'
    });
  });
});

app.get('/test-api', async (req, res) => {
  try {
    const testModel = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await testModel.generateContent('Say "API is working"');
    const response = await result.response;
    res.json({ 
      status: 'success', 
      message: response.text(),
      note: 'If this works, your API key is valid. Vision models may need to be enabled separately.'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      suggestion: 'Check your GEMINI_API_KEY in .env file'
    });
  }
});

app.post('/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const filePath = req.file.path;

  try {
    const imageData = fs.readFileSync(filePath);
    const base64Image = imageData.toString('base64');

    const systemPrompt = `You are an Indian Nutritionist. Analyze the image of the Indian meal (Thali). 
    Return strictly JSON with the following structure:
    {
      "items": [
        {
          "name": "string",
          "calories": number,
          "protein": number,
          "carbs": number,
          "fats": number
        }
      ],
      "total_calories": number,
      "macros_summary": {
        "protein": number,
        "carbs": number,
        "fats": number
      },
      "advice": "string"
    }
    
    Identify all food items visible in the image (Roti, Dal, Sabzi, Rice, etc.) and provide accurate nutritional estimates. 
    The advice should be brief and practical nutrition tips.`;

    const modelNames = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
    let result;
    let lastError;

    for (const modelName of modelNames) {
      try {
        console.log(`Trying model: ${modelName}`);
        const model = genAI.getGenerativeModel({ model: modelName });
        result = await model.generateContent([
          systemPrompt,
          {
            inlineData: {
              data: base64Image,
              mimeType: req.file.mimetype
            }
          }
        ]);
        console.log(`Successfully used model: ${modelName}`);
        break;
      } catch (modelError) {
        lastError = modelError;
        console.log(`Model ${modelName} failed: ${modelError.message}`);
        continue;
      }
    }

    if (!result) {
      throw lastError || new Error('All models failed. Please check your API key and model availability.');
    }

    const response = await result.response;
    const text = response.text();

    let jsonData;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      return res.status(500).json({ 
        error: 'Failed to parse AI response',
        rawResponse: text 
      });
    }

    fs.unlinkSync(filePath);

    res.json(jsonData);
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    console.error('Error analyzing image:', error);
    res.status(500).json({ error: 'Failed to analyze image', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

