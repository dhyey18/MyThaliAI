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
const FavoriteMeal = require('./models/FavoriteMeal');

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
      dietaryContext = 'CRITICAL: User follows Jain diet. FORBIDDEN items: onion, garlic, root vegetables (potato, carrot, radish, beetroot, turnip), non-vegetarian items. If detected, add explicit warning in advice.';
    } else if (dietaryPreference === 'Vegan') {
      dietaryContext = 'CRITICAL: User follows Vegan diet. FORBIDDEN: All dairy (milk, ghee, paneer, yogurt, butter, cheese), eggs, honey. If detected, warn in advice.';
    } else if (dietaryPreference === 'Keto') {
      dietaryContext = 'CRITICAL: User follows Keto diet. FLAG high-carb items (rice, roti, bread, potato) and suggest keto alternatives in advice. Target: <15g net carbs per meal.';
    } else if (dietaryPreference === 'High Protein') {
      dietaryContext = 'CRITICAL: User wants high protein meals. Target minimum 25-30g protein per meal. Highlight protein-rich items and suggest additions if protein is low.';
    }

    const systemPrompt = `You are an expert Indian nutritionist specializing in traditional Indian meals (Thalis). Analyze the meal image with high accuracy.

ANALYSIS REQUIREMENTS:
1. Identify EVERY food item visible - be specific (e.g., "Aloo Gobi" not just "Sabzi", "Dal Makhani" not just "Dal")
2. Estimate portion sizes accurately using Indian standard portions:
   - 1 Roti/Chapati: ~30g = 70-80 calories
   - 1 Katori Dal (150ml): 120-150 calories
   - 1 Katori Sabzi (100g): varies 50-200 calories based on type
   - 1 Katori Rice (150g cooked): 200-220 calories
   - 1 Papad: ~15g = 60-70 calories
   - Raita/Curd: ~100g = 50-80 calories
   - Salad: ~50g = 15-25 calories
   - Pickle: ~10g = 10-20 calories
   - Chutney: ~20g = 20-40 calories

3. Consider cooking methods:
   - Estimate oil/ghee used (typically 1-2 tsp per sabzi = 40-80 calories)
   - Fried items have higher calories
   - Gravy-based dishes have more calories than dry sabzis

4. Calculate macros accurately:
   - Protein: 4 calories per gram
   - Carbs: 4 calories per gram  
   - Fats: 9 calories per gram
   - Total calories = (protein × 4) + (carbs × 4) + (fats × 9)

${dietaryContext}

Return ONLY valid JSON (no markdown, no code blocks, no explanations):
{
  "items": [
    {
      "name": "Specific food name (e.g., 'Aloo Gobi', 'Dal Makhani', '2 Rotis')",
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
  "advice": "2-3 practical nutrition tips based on the meal analysis. ${dietaryPreference !== 'Standard' ? `Include ${dietaryPreference} specific recommendations.` : ''}"
}

CRITICAL: Ensure total_calories matches the sum of all item calories. Ensure macros_summary matches sum of all items' macros. Be precise and accurate.`;

    const modelNames = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
    let result;
    let lastError;

    for (const modelName of modelNames) {
      try {
        console.log(`Trying model: ${modelName}`);
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          generationConfig: {
            temperature: 0.3,
            topP: 0.9,
            topK: 40,
          }
        });
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
      let cleanText = text.trim();
      cleanText = cleanText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }

      if (!jsonData.items || !Array.isArray(jsonData.items)) {
        throw new Error('Invalid response structure: missing items array');
      }

      const calculatedTotalCalories = jsonData.items.reduce((sum, item) => sum + (item.calories || 0), 0);
      const calculatedProtein = jsonData.items.reduce((sum, item) => sum + (item.protein || 0), 0);
      const calculatedCarbs = jsonData.items.reduce((sum, item) => sum + (item.carbs || 0), 0);
      const calculatedFats = jsonData.items.reduce((sum, item) => sum + (item.fats || 0), 0);

      const calorieDiff = Math.abs(calculatedTotalCalories - (jsonData.total_calories || 0));
      if (calorieDiff > 50) {
        console.warn(`Calorie mismatch: calculated ${calculatedTotalCalories}, reported ${jsonData.total_calories}. Using calculated value.`);
        jsonData.total_calories = Math.round(calculatedTotalCalories);
      }

      const proteinDiff = Math.abs(calculatedProtein - (jsonData.macros_summary?.protein || 0));
      const carbsDiff = Math.abs(calculatedCarbs - (jsonData.macros_summary?.carbs || 0));
      const fatsDiff = Math.abs(calculatedFats - (jsonData.macros_summary?.fats || 0));

      if (proteinDiff > 5 || carbsDiff > 5 || fatsDiff > 5) {
        console.warn('Macro mismatch detected, using calculated values.');
        jsonData.macros_summary = {
          protein: Math.round(calculatedProtein * 10) / 10,
          carbs: Math.round(calculatedCarbs * 10) / 10,
          fats: Math.round(calculatedFats * 10) / 10
        };
      }

      if (!jsonData.macros_summary) {
        jsonData.macros_summary = {
          protein: Math.round(calculatedProtein * 10) / 10,
          carbs: Math.round(calculatedCarbs * 10) / 10,
          fats: Math.round(calculatedFats * 10) / 10
        };
      }

    } catch (parseError) {
      console.error('Parse error:', parseError);
      return res.status(500).json({ 
        error: 'Failed to parse AI response',
        rawResponse: text.substring(0, 500)
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

app.get('/meals/export/csv', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = {};
    
    if (startDate && endDate) {
      query.timestamp = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const meals = await Meal.find(query).sort({ timestamp: -1 }).lean();
    
    const csvHeaders = 'Date,Meal Type,Dietary Preference,Total Calories,Protein (g),Carbs (g),Fats (g),Items,Advice\n';
    const csvRows = meals.map(meal => {
      const date = new Date(meal.timestamp).toISOString().split('T')[0];
      const items = (meal.items || []).map(item => item.name).join('; ');
      const advice = (meal.advice || '').replace(/,/g, ';').replace(/\n/g, ' ');
      return `${date},${meal.mealType || ''},${meal.dietaryPreference || 'Standard'},${meal.totalCalories || 0},${meal.macros?.protein || 0},${meal.macros?.carbs || 0},${meal.macros?.fats || 0},"${items}","${advice}"`;
    });
    
    const csv = csvHeaders + csvRows.join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=meals-export-${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/meals/weekly-summary', async (req, res) => {
  try {
    const { weekStart } = req.query;
    const startDate = weekStart ? new Date(weekStart) : new Date();
    startDate.setDate(startDate.getDate() - startDate.getDay());
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
    
    const meals = await Meal.find({
      timestamp: { $gte: startDate, $lte: endDate }
    }).lean();
    
    const summary = {
      weekStart: startDate.toISOString().split('T')[0],
      weekEnd: endDate.toISOString().split('T')[0],
      totalMeals: meals.length,
      totalCalories: 0,
      avgDailyCalories: 0,
      totalProtein: 0,
      totalCarbs: 0,
      totalFats: 0,
      dailyBreakdown: {},
      mealTypeBreakdown: {},
      dietaryPreferenceBreakdown: {}
    };
    
    meals.forEach(meal => {
      summary.totalCalories += meal.totalCalories || 0;
      summary.totalProtein += meal.macros?.protein || 0;
      summary.totalCarbs += meal.macros?.carbs || 0;
      summary.totalFats += meal.macros?.fats || 0;
      
      const date = new Date(meal.timestamp).toISOString().split('T')[0];
      if (!summary.dailyBreakdown[date]) {
        summary.dailyBreakdown[date] = {
          calories: 0,
          protein: 0,
          carbs: 0,
          fats: 0,
          mealCount: 0
        };
      }
      summary.dailyBreakdown[date].calories += meal.totalCalories || 0;
      summary.dailyBreakdown[date].protein += meal.macros?.protein || 0;
      summary.dailyBreakdown[date].carbs += meal.macros?.carbs || 0;
      summary.dailyBreakdown[date].fats += meal.macros?.fats || 0;
      summary.dailyBreakdown[date].mealCount += 1;
      
      const mealType = meal.mealType || 'Other';
      summary.mealTypeBreakdown[mealType] = (summary.mealTypeBreakdown[mealType] || 0) + 1;
      
      const dietPref = meal.dietaryPreference || 'Standard';
      summary.dietaryPreferenceBreakdown[dietPref] = (summary.dietaryPreferenceBreakdown[dietPref] || 0) + 1;
    });
    
    const daysWithMeals = Object.keys(summary.dailyBreakdown).length;
    summary.avgDailyCalories = daysWithMeals > 0 ? Math.round(summary.totalCalories / daysWithMeals) : 0;
    
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/meals/insights', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    
    const meals = await Meal.find({
      timestamp: { $gte: daysAgo }
    }).sort({ timestamp: -1 }).lean();
    
    if (meals.length === 0) {
      return res.json({ insights: ['Not enough meal data to generate insights. Start logging meals to see insights!'] });
    }
    
    const totalCalories = meals.reduce((sum, m) => sum + (m.totalCalories || 0), 0);
    const avgCalories = Math.round(totalCalories / meals.length);
    const totalProtein = meals.reduce((sum, m) => sum + (m.macros?.protein || 0), 0);
    const avgProtein = Math.round(totalProtein / meals.length);
    
    const mealTypes = {};
    meals.forEach(meal => {
      const type = meal.mealType || 'Other';
      mealTypes[type] = (mealTypes[type] || 0) + 1;
    });
    
    const mostCommonMealType = Object.keys(mealTypes).reduce((a, b) => 
      mealTypes[a] > mealTypes[b] ? a : b
    );
    
    const insights = [];
    
    if (avgCalories < 300) {
      insights.push(`Your average meal contains ${avgCalories} calories, which is quite light. Consider adding more nutrient-dense foods.`);
    } else if (avgCalories > 800) {
      insights.push(`Your average meal contains ${avgCalories} calories. Consider portion control for better weight management.`);
    } else {
      insights.push(`Your average meal contains ${avgCalories} calories, which is well-balanced.`);
    }
    
    if (avgProtein < 15) {
      insights.push(`Average protein per meal is ${avgProtein}g. Try including more protein-rich foods like dal, paneer, or legumes.`);
    } else if (avgProtein > 40) {
      insights.push(`Great! Your meals average ${avgProtein}g of protein, which is excellent for muscle maintenance.`);
    }
    
    insights.push(`You've logged ${meals.length} meals in the last ${days} days. ${mostCommonMealType} is your most common meal type.`);
    
    const recentMeals = meals.slice(0, 7);
    const recentAvgCal = Math.round(recentMeals.reduce((sum, m) => sum + (m.totalCalories || 0), 0) / recentMeals.length);
    if (recentAvgCal > avgCalories + 100) {
      insights.push(`Your recent meals have been higher in calories (${recentAvgCal} avg) compared to your overall average.`);
    } else if (recentAvgCal < avgCalories - 100) {
      insights.push(`Your recent meals have been lower in calories (${recentAvgCal} avg) - great for weight management!`);
    }
    
    res.json({ insights });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/favorites', async (req, res) => {
  try {
    const favoriteData = {
      name: req.body.name || 'Untitled Meal',
      items: req.body.items || [],
      totalCalories: req.body.totalCalories || 0,
      macros: {
        protein: req.body.macros?.protein || req.body.macros_summary?.protein || 0,
        carbs: req.body.macros?.carbs || req.body.macros_summary?.carbs || 0,
        fats: req.body.macros?.fats || req.body.macros_summary?.fats || 0
      },
      mealType: req.body.mealType || 'Lunch',
      dietaryPreference: req.body.dietaryPreference || 'Standard',
      createdAt: new Date()
    };
    
    const favorite = await FavoriteMeal.create(favoriteData);
    res.json({ success: true, favorite });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/favorites', async (req, res) => {
  try {
    const favorites = await FavoriteMeal.find().sort({ createdAt: -1 }).lean();
    res.json({ favorites });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/favorites/:id', async (req, res) => {
  try {
    await FavoriteMeal.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/meals/quick-add', async (req, res) => {
  try {
    const mealData = {
      imageUrl: '',
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
      advice: req.body.advice || 'Manually added meal'
    };
    
    const newMeal = await Meal.create(mealData);
    res.json({ success: true, meal: newMeal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function loadDailyTracker() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const filePath = path.join(dataDir, 'tracker.json');
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  }
  return {};
}

function saveDailyTracker(tracker) {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const filePath = path.join(dataDir, 'tracker.json');
  fs.writeFileSync(filePath, JSON.stringify(tracker, null, 2));
}


