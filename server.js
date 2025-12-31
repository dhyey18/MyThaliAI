const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://pateldhyey418_db_user:UQZSbUPBN0Zk877e@cluster0.yb8dlob.mongodb.net/?appName=Cluster0', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log('MongoDB connected successfully');
    
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

startServer();

const Meal = require('./models/Meal');

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

const getMealType = () => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return 'Breakfast';
  if (hour >= 11 && hour < 16) return 'Lunch';
  if (hour >= 16 && hour < 21) return 'Dinner';
  return 'Snack';
};

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
  const dietaryPreference = req.body.dietaryPreference || 'Standard';
  const mealType = getMealType();

  try {
    const imageData = fs.readFileSync(filePath);
    const base64Image = imageData.toString('base64');

    let dietaryContext = '';
    if (dietaryPreference === 'Jain') {
      dietaryContext = 'IMPORTANT: The user follows Jain dietary restrictions. If you detect onion, garlic, root vegetables (potato, carrot, radish), or any non-vegetarian items, explicitly warn the user in the advice section.';
    } else if (dietaryPreference === 'Vegan') {
      dietaryContext = 'IMPORTANT: The user follows a Vegan diet. Ensure no animal products (dairy, ghee, paneer, yogurt) are present. If detected, warn in the advice section.';
    } else if (dietaryPreference === 'Keto') {
      dietaryContext = 'IMPORTANT: The user follows a Keto diet. Highlight high-carb items (rice, roti, bread) and suggest alternatives in the advice section.';
    } else if (dietaryPreference === 'High Protein') {
      dietaryContext = 'IMPORTANT: The user wants high protein meals. Emphasize protein-rich items and suggest protein additions if the meal is low in protein.';
    }

    const systemPrompt = `You are an Indian Nutritionist. Analyze the image of the Indian meal (Thali). 
    ${dietaryContext}
    
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
    The advice should be brief and practical nutrition tips. ${dietaryPreference !== 'Standard' ? `Consider the user's ${dietaryPreference} dietary preference in your advice.` : ''}`;

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

    const mealData = {
      imageUrl: `data:${req.file.mimetype};base64,${base64Image}`,
      items: jsonData.items || [],
      totalCalories: jsonData.total_calories || 0,
      macros: {
        protein: jsonData.macros_summary?.protein || 0,
        carbs: jsonData.macros_summary?.carbs || 0,
        fats: jsonData.macros_summary?.fats || 0
      },
      timestamp: new Date(),
      mealType: mealType,
      dietaryPreference: dietaryPreference,
      advice: jsonData.advice || ''
    };

    const savedMeal = await Meal.create(mealData);
    console.log('Meal saved to MongoDB:', savedMeal._id);

    fs.unlinkSync(filePath);

    res.json({
      ...jsonData,
      id: savedMeal._id,
      mealType: mealType,
      dietaryPreference: dietaryPreference
    });
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    console.error('Error analyzing image:', error);
    res.status(500).json({ error: 'Failed to analyze image', details: error.message });
  }
});

app.get('/history', async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const meals = await Meal.find({
      timestamp: { $gte: sevenDaysAgo }
    })
    .sort({ timestamp: -1 })
    .lean();

    const formattedMeals = meals.map(meal => ({
      id: meal._id.toString(),
      items: meal.items,
      total_calories: meal.totalCalories,
      macros_summary: {
        protein: meal.macros.protein,
        carbs: meal.macros.carbs,
        fats: meal.macros.fats
      },
      timestamp: meal.timestamp,
      mealType: meal.mealType,
      dietaryPreference: meal.dietaryPreference,
      advice: meal.advice,
      createdAt: meal.createdAt || meal.timestamp
    }));

    res.json({ meals: formattedMeals });
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch meal history', details: error.message });
  }
});

app.post('/meals', async (req, res) => {
  try {
    const mealData = {
      imageUrl: req.body.imageUrl || '',
      items: req.body.items || [],
      totalCalories: req.body.total_calories || req.body.totalCalories || 0,
      macros: {
        protein: req.body.macros_summary?.protein || req.body.macros?.protein || 0,
        carbs: req.body.macros_summary?.carbs || req.body.macros?.carbs || 0,
        fats: req.body.macros_summary?.fats || req.body.macros?.fats || 0
      },
      timestamp: req.body.timestamp ? new Date(req.body.timestamp) : new Date(),
      mealType: req.body.mealType || getMealType(),
      dietaryPreference: req.body.dietaryPreference || 'Standard',
      advice: req.body.advice || ''
    };
    const newMeal = await Meal.create(mealData);
    res.json({ success: true, meal: newMeal });
  } catch (error) {
    console.error('Error saving meal:', error);
    res.status(500).json({ error: error.message, details: error.stack });
  }
});

app.get('/meals', async (req, res) => {
  try {
    const { date, limit } = req.query;
    let query = {};
    
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      query.timestamp = { $gte: startDate, $lte: endDate };
    }
    
    let mealsQuery = Meal.find(query).sort({ timestamp: -1 });
    
    if (limit) {
      mealsQuery = mealsQuery.limit(parseInt(limit));
    }
    
    const meals = await mealsQuery.lean();
    
    const formattedMeals = meals.map(meal => ({
      id: meal._id.toString(),
      ...meal,
      total_calories: meal.totalCalories,
      macros_summary: meal.macros,
      createdAt: meal.createdAt || meal.timestamp
    }));
    
    res.json({ meals: formattedMeals });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/meals/:id', async (req, res) => {
  try {
    await Meal.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/meals/stats', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    
    const recentMeals = await Meal.find({
      timestamp: { $gte: daysAgo }
    }).lean();
    
    const dailyStats = {};
    recentMeals.forEach(meal => {
      const date = new Date(meal.timestamp).toDateString();
      if (!dailyStats[date]) {
        dailyStats[date] = {
          date,
          totalCalories: 0,
          totalProtein: 0,
          totalCarbs: 0,
          totalFats: 0,
          mealCount: 0
        };
      }
      dailyStats[date].totalCalories += meal.totalCalories || 0;
      dailyStats[date].totalProtein += meal.macros?.protein || 0;
      dailyStats[date].totalCarbs += meal.macros?.carbs || 0;
      dailyStats[date].totalFats += meal.macros?.fats || 0;
      dailyStats[date].mealCount += 1;
    });
    
    res.json({ stats: Object.values(dailyStats) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tracker', (req, res) => {
  try {
    const tracker = loadDailyTracker();
    const { date, goals } = req.body;
    const dateKey = new Date(date).toDateString();
    
    tracker[dateKey] = {
      date: dateKey,
      goals: goals || tracker[dateKey]?.goals || {
        calories: 2000,
        protein: 150,
        carbs: 250,
        fats: 65
      },
      updatedAt: new Date().toISOString()
    };
    
    saveDailyTracker(tracker);
    res.json({ success: true, tracker: tracker[dateKey] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/tracker', (req, res) => {
  try {
    const tracker = loadDailyTracker();
    const { date } = req.query;
    
    if (date) {
      const dateKey = new Date(date).toDateString();
      res.json({ tracker: tracker[dateKey] || null });
    } else {
      res.json({ tracker });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


